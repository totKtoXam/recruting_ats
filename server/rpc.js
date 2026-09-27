// Реестр RPC-методов, которые раньше вызывались через google.script.run.
// Имена и формат ответов сохранены, поэтому фронтенд работает без изменений.
import * as candidates from './services/candidates.js';
import * as comments from './services/comments.js';
import * as drafts from './services/drafts.js';
import * as interviews from './services/interviews.js';
import * as lifecycle from './services/lifecycle.js';
import * as lists from './services/lists.js';
import * as references from './services/references.js';
import * as users from './services/users.js';

async function getCandidateData() {
  const [active, archivedCount] = await Promise.all([
    candidates.getCandidateSummaries(),
    candidates.getArchivedCandidateCount()
  ]);

  return {
    candidates: active,
    stats: candidates.calculateStats(active, archivedCount)
  };
}

async function getBootstrapData(_args, { user }) {
  await users.touchLastLogin(user.id);
  // Фоновое обслуживание без cron: очистка черновиков и окончательное удаление из корзины.
  drafts.cleanupDraftsIfDue();
  lifecycle.purgeIfDue();

  const [referenceData, candidateData] = await Promise.all([
    references.getReferenceData(),
    getCandidateData()
  ]);

  return {
    currentUser: users.toPublicUser(user),
    ...referenceData,
    ...candidateData
  };
}

const adminOnly = handler => (input, context) => {
  users.requireAdmin(context.user);
  return handler(input, context);
};

export const rpcHandlers = {
  getBootstrapData,
  getInitialData: getBootstrapData,
  getReferenceData: () => references.getReferenceData(),
  getCandidateData,
  getArchivedCandidateData: async () => ({
    archivedCandidates: await candidates.getArchivedCandidateSummaries()
  }),
  getDeletedCandidateData: async () => ({
    deletedCandidates: await candidates.getDeletedCandidateSummaries()
  }),
  getAdminUserData: async () => ({ users: await users.getUsers() }),

  getCandidateDetails: id => candidates.getCandidateDetails(id),
  saveCandidate: (payload, { user }) => candidates.saveCandidate(payload, user),
  archiveCandidate: id => candidates.archiveCandidate(id),
  unarchiveCandidate: id => candidates.unarchiveCandidate(id),
  getAllowedTransitions: id => candidates.getAllowedTransitions(id),
  getCandidateTransitionStatusLog: id => candidates.getCandidateTransitionStatusLog(id),
  getCandidateDraft: token => drafts.getCandidateDraft(token),

  getInterviews: id => interviews.getInterviews(id),
  getInterviewContext: input => interviews.getInterviewContext(input),
  transitionCandidate: (input, { user }) => interviews.transitionCandidate(input, user),
  updateInterview: input => interviews.updateInterview(input),

  // Жизненный цикл любой записи: { type: candidate|vacancy|source|template|interview|user, id }.
  archiveEntity: (input, { user }) => lifecycle.archive(input, user),
  unarchiveEntity: (input, { user }) => lifecycle.unarchive(input, user),
  deleteEntity: (input, { user }) => lifecycle.moveToTrash(input, user),
  restoreEntity: (input, { user }) => lifecycle.restoreFromTrash(input, user),

  // Комментарии и реакции.
  listComments: (input, { user }) => comments.listComments(input, user),
  addComment: (input, { user }) => comments.addComment(input, user),
  updateComment: (input, { user }) => comments.updateComment(input, user),
  deleteComment: (id, { user }) => comments.deleteComment(id, user),
  toggleReaction: (input, { user }) => comments.toggleReaction(input, user),

  // Серверные таблицы: фильтры, сортировка и пагинация в БД.
  listVacancies: input => lists.listVacancies(input),
  listSources: input => lists.listSources(input),
  listUsers: adminOnly(input => lists.listUsers(input)),

  // Пользователи (они же ответственные) — только администраторы.
  saveUser: (input, { user }) => users.saveUser(input, user),
  setUserAccess: (input, { user }) => users.setUserAccess(input, user),

  saveVacancy: input => references.saveVacancy(input),
  setVacancyStatus: input => references.setVacancyStatus(input),
  listVacancyTemplates: vacancyId => references.listVacancyTemplates(vacancyId),
  saveSource: input => references.saveSource(input),
  saveInterviewTemplate: input => references.saveInterviewTemplate(input)
};
