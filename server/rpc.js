// Реестр RPC-методов, которые раньше вызывались через google.script.run.
// Имена и формат ответов сохранены, поэтому фронтенд работает без изменений.
import * as candidates from './services/candidates.js';
import * as drafts from './services/drafts.js';
import * as interviews from './services/interviews.js';
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
  drafts.cleanupDraftsIfDue();

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

export const rpcHandlers = {
  getBootstrapData,
  getInitialData: getBootstrapData,
  getReferenceData: () => references.getReferenceData(),
  getCandidateData,
  getArchivedCandidateData: async () => ({
    archivedCandidates: await candidates.getArchivedCandidateSummaries()
  }),
  getAdminUserData: async () => ({ users: await users.getUsers() }),

  getCandidateDetails: id => candidates.getCandidateDetails(id),
  saveCandidate: (payload, { user }) => candidates.saveCandidate(payload, user),
  archiveCandidate: id => candidates.archiveCandidate(id),
  getAllowedTransitions: id => candidates.getAllowedTransitions(id),
  getCandidateTransitionStatusLog: id => candidates.getCandidateTransitionStatusLog(id),
  getCandidateDraft: token => drafts.getCandidateDraft(token),

  getInterviews: id => interviews.getInterviews(id),
  getInterviewContext: input => interviews.getInterviewContext(input),
  transitionCandidate: (input, { user }) => interviews.transitionCandidate(input, user),
  updateInterview: input => interviews.updateInterview(input),
  deleteInterview: id => interviews.deleteInterview(id),

  saveVacancy: input => references.saveVacancy(input),
  deleteVacancy: id => references.deleteVacancy(id),
  saveSource: input => references.saveSource(input),
  deleteSource: id => references.deleteSource(id),
  saveResponsible: input => references.saveResponsible(input),
  deleteResponsible: id => references.deleteResponsible(id),
  saveInterviewTemplate: input => references.saveInterviewTemplate(input),
  deleteInterviewTemplate: id => references.deleteInterviewTemplate(id)
};
