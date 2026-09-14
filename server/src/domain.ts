/** Domain types are deliberately small so the persistence adapter can later move to PostgreSQL. */
export type QuizStatus = 'DRAFT' | 'OPEN' | 'CLOSED';
export type Question = { id: string; label: string; choices: string[]; answerIndex: number };
export type Quiz = { id: string; title: string; status: QuizStatus; durationSeconds: number; questions: Question[]; openedAt?: string; closedAt?: string };
export type Participant = { id: string; name: string; accessCode: string };
export type Submission = { id: string; quizId: string; participantId: string; answers: number[]; score: number; submittedAt: string };
/** An attempt records each participant's personal clock independently of the quiz opening time. */
export type Attempt = { id: string; quizId: string; participantId: string; startedAt: string };
export type Store = { quizzes: Quiz[]; participants: Participant[]; attempts: Attempt[]; submissions: Submission[] };

export const publicQuiz = (quiz: Quiz) => ({
  ...quiz,
  // Correct answers must never be sent to participants before the quiz is finished.
  questions: quiz.questions.map(({ answerIndex: _answerIndex, ...question }) => question),
});

/** Administrators receive the answer key only from a protected endpoint. */
export const adminQuiz = (quiz: Quiz) => ({ ...quiz });

export const seedStore = (): Store => ({
  quizzes: [{ id: 'quiz-1', title: 'Clean City', status: 'DRAFT', durationSeconds: 90, questions: [
    { id: 'q1', label: 'Quel est le principal objectif du tri des déchets ?', choices: ['Réduire la pollution', 'Augmenter les déchets', 'Supprimer les parcs', 'Fermer les écoles'], answerIndex: 0 },
    { id: 'q2', label: 'Une ville durable privilégie...', choices: ['Le gaspillage', 'La mobilité douce', 'Le plastique à usage unique', 'Les embouteillages'], answerIndex: 1 },
    { id: 'q3', label: 'Quel geste économise l eau ?', choices: ['Laisser couler le robinet', 'Réparer les fuites', 'Laver la rue chaque jour', 'Prendre des bains très longs'], answerIndex: 1 },
  ] }], participants: [], attempts: [], submissions: []
});
