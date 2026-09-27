// Комментарии с авторами и реакциями у кандидатов, вакансий и результатов интервью.
//   - Редактировать может только автор, удалить — автор или администратор.
//   - Ответы — один уровень вложенности.
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { richFromInput } from '../lib/richtext.js';
import { isUuid, optionalUuid } from '../lib/validation.js';
import { userDisplayName } from './mappers.js';

export const REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

const ENTITY_TABLES = {
  candidate: 'candidates',
  vacancy: 'vacancies',
  interview: 'interviews'
};

async function assertEntity(executor, entityType, entityId) {
  const table = ENTITY_TABLES[entityType];

  if (!table) {
    fail('Комментарии для этого типа записей не поддерживаются.');
  }

  const row = isUuid(entityId)
    ? await executor.one(`SELECT id, deleted_at FROM ${table} WHERE id = $1`, [entityId])
    : null;

  if (!row) {
    fail('Запись не найдена.', 404);
  }

  return row;
}

const COMMENT_SELECT = `
  SELECT c.*, u.email AS author_email, u.avatar_url AS author_avatar,
         u.last_name AS author_last_name, u.first_name AS author_first_name,
         u.middle_name AS author_middle_name, u.full_name AS author_full_name,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('emoji', r.emoji, 'userId', r.user_id, 'name',
             coalesce(nullif(concat_ws(' ', nullif(ru.last_name, ''), nullif(ru.first_name, '')), ''), ru.email))
             ORDER BY r.created_at)
           FROM comment_reactions r JOIN users ru ON ru.id = r.user_id
           WHERE r.comment_id = c.id
         ), '[]'::jsonb) AS reactions_raw
  FROM comments c
  LEFT JOIN users u ON u.id = c.author_id
`;

function groupReactions(raw, actor) {
  const byEmoji = new Map();

  for (const reaction of raw || []) {
    const entry = byEmoji.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false, users: [] };
    entry.count += 1;
    entry.users.push(reaction.name);
    if (actor && reaction.userId === actor.id) entry.mine = true;
    byEmoji.set(reaction.emoji, entry);
  }

  return REACTIONS.filter(emoji => byEmoji.has(emoji)).map(emoji => byEmoji.get(emoji));
}

function toComment(row, actor) {
  const author = row.author_id
    ? {
        id: row.author_id,
        name: userDisplayName({
          last_name: row.author_last_name,
          first_name: row.author_first_name,
          middle_name: row.author_middle_name,
          full_name: row.author_full_name,
          email: row.author_email
        }),
        email: row.author_email || '',
        avatarUrl: row.author_avatar || ''
      }
    : { id: null, name: row.author_name || 'Удалённый пользователь', email: '', avatarUrl: '' };

  const own = Boolean(actor && row.author_id === actor.id);

  return {
    id: row.id,
    parentId: row.parent_id || null,
    author,
    bodyHtml: row.body_html,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    edited: Boolean(row.updated_at),
    reactions: groupReactions(row.reactions_raw, actor),
    canEdit: own,
    canDelete: own || Boolean(actor && actor.is_admin)
  };
}

export async function listComments({ entityType, entityId } = {}, actor) {
  await assertEntity(db, entityType, entityId);

  const rows = await db.many(
    COMMENT_SELECT + ' WHERE c.entity_type = $1 AND c.entity_id = $2 ORDER BY c.created_at',
    [entityType, entityId]
  );
  return rows.map(row => toComment(row, actor));
}

export async function countComments(entityType, entityIds) {
  if (!entityIds.length) return {};
  const rows = await db.many(
    `SELECT entity_id, count(*)::int AS count FROM comments
     WHERE entity_type = $1 AND entity_id = ANY($2) GROUP BY entity_id`,
    [entityType, entityIds]
  );
  return Object.fromEntries(rows.map(row => [row.entity_id, row.count]));
}

// Используется и напрямую (первый комментарий при создании кандидата, комментарий к переходу).
export async function insertComment(executor, { entityType, entityId, bodyHtml, parentId = null }, actor) {
  const body = richFromInput(bodyHtml);

  if (!body) {
    return null;
  }

  const saved = await executor.one(
    `INSERT INTO comments (entity_type, entity_id, parent_id, author_id, author_name, body_html)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [entityType, entityId, parentId, actor ? actor.id : null, actor ? userDisplayName(actor) : '', body]
  );

  return saved.id;
}

export async function addComment(input = {}, actor) {
  const { entityType, entityId } = input;

  return transaction(async tx => {
    const entity = await assertEntity(tx, entityType, entityId);

    if (entity.deleted_at) {
      fail('Запись в корзине — комментировать нельзя.');
    }

    let parentId = optionalUuid(input.parentId, 'Комментарий не найден.');

    if (parentId) {
      const parent = await tx.one(
        'SELECT id, parent_id, entity_type, entity_id FROM comments WHERE id = $1',
        [parentId]
      );

      if (!parent || parent.entity_type !== entityType || parent.entity_id !== entityId) {
        fail('Комментарий не найден.', 404);
      }

      // Один уровень ответов: ответ на ответ крепится к исходному комментарию.
      parentId = parent.parent_id || parent.id;
    }

    const id = await insertComment(tx, { entityType, entityId, bodyHtml: input.bodyHtml, parentId }, actor);

    if (!id) {
      fail('Комментарий пустой.');
    }

    return toComment(await tx.one(COMMENT_SELECT + ' WHERE c.id = $1', [id]), actor);
  });
}

export async function updateComment(input = {}, actor) {
  const id = optionalUuid(input.id, 'Комментарий не найден.');
  const body = richFromInput(input.bodyHtml);

  if (!body) {
    fail('Комментарий пустой.');
  }

  const existing = id ? await db.one('SELECT author_id FROM comments WHERE id = $1', [id]) : null;

  if (!existing) {
    fail('Комментарий не найден.', 404);
  }

  if (existing.author_id !== actor.id) {
    fail('Редактировать можно только свои комментарии.', 403);
  }

  await db.query('UPDATE comments SET body_html = $2, updated_at = now() WHERE id = $1', [id, body]);

  return toComment(await db.one(COMMENT_SELECT + ' WHERE c.id = $1', [id]), actor);
}

export async function deleteComment(id, actor) {
  const commentId = optionalUuid(id, 'Комментарий не найден.');
  const existing = commentId
    ? await db.one('SELECT author_id FROM comments WHERE id = $1', [commentId])
    : null;

  if (!existing) {
    fail('Комментарий не найден.', 404);
  }

  if (existing.author_id !== actor.id && !actor.is_admin) {
    fail('Удалять можно только свои комментарии.', 403);
  }

  // Ответы удаляются вместе с комментарием (ON DELETE CASCADE).
  await db.query('DELETE FROM comments WHERE id = $1', [commentId]);
  return { ok: true };
}

export async function toggleReaction({ commentId, emoji } = {}, actor) {
  const id = optionalUuid(commentId, 'Комментарий не найден.');

  if (!REACTIONS.includes(emoji)) {
    fail('Такая реакция не поддерживается.');
  }

  return transaction(async tx => {
    const comment = id ? await tx.one('SELECT id FROM comments WHERE id = $1', [id]) : null;

    if (!comment) {
      fail('Комментарий не найден.', 404);
    }

    const removed = await tx.one(
      'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3 RETURNING 1',
      [id, actor.id, emoji]
    );

    if (!removed) {
      await tx.query(
        'INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES ($1, $2, $3)',
        [id, actor.id, emoji]
      );
    }

    const row = await tx.one(COMMENT_SELECT + ' WHERE c.id = $1', [id]);
    return { reactions: groupReactions(row.reactions_raw, actor) };
  });
}
