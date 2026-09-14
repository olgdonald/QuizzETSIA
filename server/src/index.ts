import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadStore, saveStore } from './store.js';
import { adminQuiz, publicQuiz, type Quiz, type Store } from './domain.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.CLIENT_ORIGIN?.split(',') ?? true });
await app.register(sensible);
// Without this handler, a Zod validation failure (bad admin input, malformed body, etc.)
// bubbles up as an uncaught error and Fastify answers 500 instead of 400.
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'Données invalides', details: error.issues });
  }
  return reply.send(error);
});
const io = new Server(app.server, { cors: { origin: process.env.CLIENT_ORIGIN?.split(',') ?? '*' } });
const store: Store = await loadStore();

const notify = () => io.emit('quizzes:changed', store.quizzes.map(publicQuiz));
const activeQuiz = () => store.quizzes.find(q => q.status === 'OPEN');
const findQuiz = (id: string) => store.quizzes.find(q => q.id === id);
async function persistAndNotify() { await saveStore(store); notify(); }

// In production ADMIN_PASSWORD must be a long secret; an external identity provider is preferable.
function assertAdmin(request: { headers: Record<string, unknown> }) {
  if (!process.env.ADMIN_PASSWORD || request.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) throw app.httpErrors.unauthorized('Accès administrateur refusé');
}
app.get('/health', async () => ({ ok: true }));
app.get('/api/quizzes', async () => store.quizzes.map(publicQuiz));
const sessionInput = z.object({ name: z.string().trim().min(2).max(60), accessCode: z.string().trim().min(4).max(24) });
app.post('/api/session/register', async (request) => {
  const body = sessionInput.parse(request.body);
  const alreadyExists = store.participants.some(p => p.name.toLocaleLowerCase() === body.name.toLocaleLowerCase() && p.accessCode === body.accessCode);
  if (alreadyExists) throw app.httpErrors.conflict('Ce compte existe déjà. Utilisez Connexion.');
  const participant = { id: randomUUID(), ...body }; store.participants.push(participant); await saveStore(store);
  return { id: participant.id, name: participant.name };
});
app.post('/api/session/login', async (request) => {
  const body = sessionInput.parse(request.body);
  const participant = store.participants.find(p => p.name.toLocaleLowerCase() === body.name.toLocaleLowerCase() && p.accessCode === body.accessCode);
  if (!participant) throw app.httpErrors.unauthorized('Nom ou code de sécurité incorrect.');
  return { id: participant.id, name: participant.name };
});
app.post('/api/quizzes/:id/start', async (request) => {
  const quiz = findQuiz((request.params as { id: string }).id);
  const body = z.object({ participantId: z.string().uuid() }).parse(request.body);
  if (!quiz || quiz.status !== 'OPEN') throw app.httpErrors.conflict('Ce quiz n accepte plus de nouveaux participants');
  if (!store.participants.some(p => p.id === body.participantId)) throw app.httpErrors.unauthorized('Session invalide');
  if (store.submissions.some(s => s.quizId === quiz.id && s.participantId === body.participantId)) throw app.httpErrors.conflict('Vous avez déjà participé à ce quiz');
  let attempt = store.attempts.find(a => a.quizId === quiz.id && a.participantId === body.participantId);
  if (!attempt) { attempt = { id: randomUUID(), quizId: quiz.id, participantId: body.participantId, startedAt: new Date().toISOString() }; store.attempts.push(attempt); await saveStore(store); }
  return { quiz: publicQuiz(quiz), startedAt: attempt.startedAt };
});
app.post('/api/quizzes/:id/submit', async (request) => {
  const quiz = findQuiz((request.params as { id: string }).id);
  const body = z.object({ participantId: z.string().uuid(), answers: z.array(z.number().int().min(0).max(10)) }).parse(request.body);
  if (!quiz) throw app.httpErrors.notFound('Quiz introuvable');
  if (!store.participants.some(p => p.id === body.participantId)) throw app.httpErrors.unauthorized('Session invalide');
  if (store.submissions.some(s => s.quizId === quiz.id && s.participantId === body.participantId)) throw app.httpErrors.conflict('Vous avez déjà participé à ce quiz');
  const attempt = store.attempts.find(a => a.quizId === quiz.id && a.participantId === body.participantId);
  if (!attempt) throw app.httpErrors.conflict('Vous devez commencer le quiz avant de répondre');
  if (Date.now() > new Date(attempt.startedAt).getTime() + quiz.durationSeconds * 1000) throw app.httpErrors.conflict('Votre temps est écoulé');
  const score = quiz.questions.reduce((sum, question, index) => sum + Number(question.answerIndex === body.answers[index]), 0);
  store.submissions.push({ id: randomUUID(), quizId: quiz.id, participantId: body.participantId, answers: body.answers, score, submittedAt: new Date().toISOString() });
  await saveStore(store); io.emit('submission:received', { quizId: quiz.id });
  return { score };
});
app.post('/api/admin/login', async (request) => { assertAdmin(request); return { ok: true }; });
app.get('/api/admin/quizzes', async request => { assertAdmin(request); return store.quizzes.map(adminQuiz); });
app.post('/api/admin/quizzes', async (request) => {
  assertAdmin(request); const body = z.object({ title: z.string().trim().min(2).max(80), questions: z.array(z.object({ label: z.string().min(5), choices: z.array(z.string().min(1)).min(2), answerIndex: z.number().int().min(0) })).min(1).max(20), durationSeconds: z.number().int().min(30).max(600).default(90) }).parse(request.body);
  if (body.questions.some(q => q.answerIndex >= q.choices.length)) throw app.httpErrors.badRequest('Réponse correcte invalide');
  const quiz: Quiz = { id: randomUUID(), ...body, status: 'DRAFT', questions: body.questions.map(q => ({ ...q, id: randomUUID() })) };
  store.quizzes.push(quiz); await persistAndNotify(); return quiz;
});
app.patch('/api/admin/quizzes/:id', async (request) => {
  assertAdmin(request); const quiz = findQuiz((request.params as { id: string }).id);
  if (!quiz || quiz.status === 'OPEN') throw app.httpErrors.badRequest('Un quiz ouvert ne peut pas être modifié');
  const body = z.object({ title: z.string().trim().min(2).max(80).optional(), questions: z.array(z.object({ id: z.string().optional(), label: z.string().min(5), choices: z.array(z.string().min(1)).min(2), answerIndex: z.number().int().min(0) })).min(1).max(20).optional(), durationSeconds: z.number().int().min(30).max(600).optional() }).refine(value => Object.keys(value).length > 0).parse(request.body);
  if (body.questions?.some(q => q.answerIndex >= q.choices.length)) throw app.httpErrors.badRequest('Réponse correcte invalide');
  if (body.title) quiz.title = body.title; if (body.durationSeconds) quiz.durationSeconds = body.durationSeconds; if (body.questions) quiz.questions = body.questions.map(q => ({ ...q, id: q.id ?? randomUUID() }));
  await persistAndNotify(); return publicQuiz(quiz);
});
app.delete('/api/admin/quizzes/:id', async (request) => {
  assertAdmin(request); const index = store.quizzes.findIndex(q => q.id === (request.params as { id: string }).id);
  if (index < 0 || store.quizzes[index].status === 'OPEN') throw app.httpErrors.badRequest('Impossible de supprimer ce quiz');
  const [removed] = store.quizzes.splice(index, 1); store.submissions = store.submissions.filter(s => s.quizId !== removed.id); await persistAndNotify(); return { ok: true };
});
app.post('/api/admin/quizzes/:id/open', async (request) => {
  assertAdmin(request); if (activeQuiz()) throw app.httpErrors.conflict('Un autre quiz est déjà ouvert');
  const quiz = findQuiz((request.params as { id: string }).id); if (!quiz || quiz.status === 'CLOSED') throw app.httpErrors.badRequest('Quiz introuvable ou terminé');
  quiz.status = 'OPEN'; quiz.openedAt = new Date().toISOString(); await persistAndNotify(); return publicQuiz(quiz);
});
app.post('/api/admin/quizzes/:id/close', async (request) => {
  assertAdmin(request); const quiz = findQuiz((request.params as { id: string }).id); if (!quiz || quiz.status !== 'OPEN') throw app.httpErrors.badRequest('Quiz non ouvert');
  quiz.status = 'CLOSED'; quiz.closedAt = new Date().toISOString(); await persistAndNotify(); return publicQuiz(quiz);
});
app.post('/api/admin/quizzes/:id/reset', async (request) => {
  assertAdmin(request); const quiz = findQuiz((request.params as { id: string }).id); if (!quiz) throw app.httpErrors.notFound();
  quiz.status = 'DRAFT'; delete quiz.openedAt; delete quiz.closedAt; store.submissions = store.submissions.filter(s => s.quizId !== quiz.id); store.attempts = store.attempts.filter(a => a.quizId !== quiz.id); await persistAndNotify(); return publicQuiz(quiz);
});
app.get('/api/admin/quizzes/:id/ranking', async (request) => {
  assertAdmin(request); const quizId = (request.params as { id: string }).id;
  const ranking = store.submissions.filter(s => s.quizId === quizId).sort((a,b) => b.score - a.score || a.submittedAt.localeCompare(b.submittedAt)).map((s, index) => ({ rank: index + 1, name: store.participants.find(p => p.id === s.participantId)?.name, score: s.score, submittedAt: s.submittedAt }));
  return { total: ranking.length, ranking: ranking.slice(0, 10) };
});

io.on('connection', socket => socket.emit('quizzes:changed', store.quizzes.map(publicQuiz)));
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
