// Реестр RPC-методов, которые раньше вызывались через google.script.run.
// Имена и формат ответов сохранены, поэтому фронтенд работает без изменений.
import * as candidates from './services/candidates.js';
import * as audit from './services/audit.js';
import * as comments from './services/comments.js';
import * as dashboard from './services/dashboard.js';
import * as developer from './services/developer.js';
import * as drafts from './services/drafts.js';
import * as interviews from './services/interviews.js';
import * as lifecycle from './services/lifecycle.js';
import * as lists from './services/lists.js';
import * as notifications from './services/notifications.js';
import * as oauth from './services/oauth.js';
import * as references from './services/references.js';
import * as resumeParse from './services/resume-parse.js';
import * as settings from './services/settings.js';
import * as similar from './services/similar.js';
import * as telegram from './services/telegram.js';
import * as users from './services/users.js';
import { fail } from './lib/errors.js';

async function getCandidateData() {
  const [active, archivedCount, deletedCount] = await Promise.all([
    candidates.getCandidateSummaries(),
    candidates.getArchivedCandidateCount(),
    candidates.getDeletedCandidateCount()
  ]);

  return {
    candidates: active,
    stats: { ...candidates.calculateStats(active, archivedCount), deleted: deletedCount }
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
    notificationsUnread: await notifications.getUnreadCount(user),
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
  // Полный список пользователей с email и ролями — только администраторам.
  getAdminUserData: adminOnly(async () => ({ users: await users.getUsers() })),
  // Главная «Мой день»: очередь «на моём этапе», зависшие, вакансии по этапам, последние события.
  getHomeData: (input, { user }) => dashboard.getHomeData(input, user),
  // «Аналитика»: показатели за период, конверсия, источники, причины отказа, нагрузка.
  getAnalyticsData: input => dashboard.getAnalyticsData(input),
  // Полная сводка в прежнем формате (MCP-инструмент get_dashboard).
  getDashboardData: (input, { user }) => dashboard.getDashboardData(input, user),

  getCandidateDetails: id => candidates.getCandidateDetails(id),
  saveCandidate: (payload, { user }) => candidates.saveCandidate(payload, user),
  archiveCandidate: (id, { user }) => candidates.archiveCandidate(id, user),
  unarchiveCandidate: (id, { user }) => candidates.unarchiveCandidate(id, user),
  getAllowedTransitions: id => candidates.getAllowedTransitions(id),
  getCandidateTransitionStatusLog: id => candidates.getCandidateTransitionStatusLog(id),
  getCandidateDraft: token => drafts.getCandidateDraft(token),
  // Автозаполнение карточки из файла резюме: разбирает файл, ничего не сохраняет.
  parseResume: input => resumeParse.parseResume(input),
  // Похожие кандидаты по ФИО (нечётко) и контактам (точно) — предупреждение о дубле при заполнении формы.
  findSimilarCandidates: input => similar.findSimilarCandidates(input),

  getInterviews: id => interviews.getInterviews(id),
  getInterviewContext: input => interviews.getInterviewContext(input),
  transitionCandidate: (input, { user }) => interviews.transitionCandidate(input, user),
  updateInterview: (input, { user }) => interviews.updateInterview(input, user),

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

  // Уведомления: колокольчик, журнал, настройки, подписка на кандидата, Telegram.
  getNotificationFeed: (input, { user }) => notifications.getNotificationFeed(input, user),
  getNotificationUnread: async (_input, { user }) => ({ unread: await notifications.getUnreadCount(user) }),
  getNotification: (id, { user }) => notifications.getNotification(id, user),
  markNotificationRead: (input, { user }) => notifications.markRead(input, user),
  markAllNotificationsRead: (input, { user }) => notifications.markAllRead(input, user),
  setNotificationImportant: (input, { user }) => notifications.setImportant(input, user),
  listNotificationLog: (input, { user }) => lists.listNotificationLog(input, user),
  getNotificationSettings: (input, { user }) => notifications.getNotificationSettings(input, user),
  setNotificationPreference: (input, { user }) => notifications.setNotificationPreference(input, user),
  setNotificationPreferences: (input, { user }) => notifications.setNotificationPreferences(input, user),
  setNotificationSwitch: (input, { user }) => notifications.setNotificationSwitch(input, user),
  getCandidateWatch: (id, { user }) => notifications.getCandidateWatch(id, user),
  setCandidateWatch: (input, { user }) => notifications.setCandidateWatch(input, user),
  // Подключённые MCP-клиенты (Claude и др.): список и отключение в профиле.
  listMcpConnections: (input, { user }) => oauth.listConnections(input, user),
  revokeMcpConnection: (id, { user }) => oauth.revokeConnection(id, user),
  createMcpToken: (input, { user }) => oauth.createPersonalToken(input, user),
  revokeMcpToken: (id, { user }) => oauth.revokePersonalToken(id, user),
  // «Настройки → Для разработчиков»: версия, ссылки, MCP, Intake; состояние интеграций — администраторам.
  getDeveloperInfo: (input, { user }) => developer.getDeveloperInfo(input, user),
  createTelegramLink: (input, { user }) => telegram.createTelegramLink(input, user),
  unlinkTelegram: (input, { user }) => telegram.unlinkTelegram(input, user),

  // Интеграции (вход через Google, SMTP, Telegram) — только администраторы.
  getIntegrationSettings: (input, { user }) => settings.getIntegrationSettings(input, user),
  saveIntegration: (input, { user }) => settings.saveIntegration(input, user),
  testIntegration: (input, { user }) => settings.testIntegration(input, user),
  resetIntegration: (input, { user }) => settings.resetIntegration(input, user),

  // Серверные таблицы: фильтры, сортировка и пагинация в БД.
  listVacancies: (input, { user }) => lists.listVacancies(input, user),
  listSources: (input, { user }) => lists.listSources(input, user),
  listTemplates: (input, { user }) => lists.listTemplates(input, user),
  listUsers: adminOnly((input, { user }) => lists.listUsers(input, user)),

  // Журнал изменений любой записи и откат значения поля.
  getHistory: (input, { user }) => audit.getHistory(input, user),
  revertChange: (input, { user }) =>
    audit.revertChange(input, user, {
      afterRevert: (tx, entityType, before, _after, actor, label) =>
        entityType === 'candidate'
          ? notifications.notifyCandidateEvent(tx, before.id, actor, { type: 'updated', changes: [label], previous: before })
          : null
    }),

  // Пользователи (они же ответственные) — только администраторы.
  saveUser: (input, { user }) => users.saveUser(input, user),
  setUserAccess: (input, { user }) => users.setUserAccess(input, user),

  saveVacancy: (input, { user }) => references.saveVacancy(input, user),
  setVacancyStatus: (input, { user }) => references.setVacancyStatus(input, user),
  saveSource: (input, { user }) => references.saveSource(input, user),
  saveInterviewTemplate: (input, { user }) => references.saveInterviewTemplate(input, user)
};

// Вызов метода по имени (POST /api/rpc/:name). "args": null означает «аргумент не передан»:
// обработчики со значением по умолчанию (input = {}) иначе падают на null с ошибкой 500.
export function callRpc(name, args, context) {
  const handler = Object.hasOwn(rpcHandlers, name) ? rpcHandlers[name] : null;

  if (!handler) {
    fail('Неизвестный метод.', 404);
  }

  return handler(args === null ? undefined : args, context);
}
