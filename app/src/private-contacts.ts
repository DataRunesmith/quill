import { randomId } from "../../shared/crypto";
import type { Env } from "./db";
import {
  normalizeImportedContacts,
  normalizePrivateContactInput,
  type RecipientAddressInput,
} from "./recipient-address";

const MAX_LIST_NAME_LENGTH = 120;

export type PrivateContactInput = RecipientAddressInput;

export interface PrivateContactRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function normalizeListName(value: unknown): string {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_LIST_NAME_LENGTH);
  if (!name) throw new Error("Listnamn krävs");
  return name;
}

export async function listPrivateContacts(env: Env, accountId: string) {
  const [contactsResult, listsResult, membersResult] = await Promise.all([
    env.DB.prepare(
      "SELECT id, email, name, created_at, updated_at FROM account_contacts WHERE account_id = ? ORDER BY name COLLATE NOCASE, email COLLATE NOCASE",
    )
      .bind(accountId)
      .all<PrivateContactRow>(),
    env.DB.prepare(
      "SELECT id, name, created_at, updated_at FROM account_contact_lists WHERE account_id = ? ORDER BY name COLLATE NOCASE",
    )
      .bind(accountId)
      .all<{ id: string; name: string; created_at: number; updated_at: number }>(),
    env.DB.prepare(
      "SELECT list_id, contact_id FROM account_contact_list_members WHERE account_id = ? ORDER BY list_id, contact_id",
    )
      .bind(accountId)
      .all<{ list_id: string; contact_id: string }>(),
  ]);
  const byList = new Map<string, string[]>();
  for (const row of membersResult.results) {
    const ids = byList.get(row.list_id) ?? [];
    ids.push(row.contact_id);
    byList.set(row.list_id, ids);
  }
  return {
    contacts: contactsResult.results,
    lists: listsResult.results.map((list) => ({ ...list, contactIds: byList.get(list.id) ?? [] })),
  };
}

export async function savePrivateContact(env: Env, accountId: string, input: PrivateContactInput) {
  const contact = normalizePrivateContactInput(input);
  const now = Date.now();
  const id = randomId();
  await env.DB.prepare(
    `
    INSERT INTO account_contacts (id, account_id, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, email) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE account_contacts.name END,
      updated_at = excluded.updated_at
  `,
  )
    .bind(id, accountId, contact.email, contact.name, now, now)
    .run();
  return env.DB.prepare(
    "SELECT id, email, name, created_at, updated_at FROM account_contacts WHERE account_id = ? AND email = ?",
  )
    .bind(accountId, contact.email)
    .first<PrivateContactRow>();
}

export async function deletePrivateContact(
  env: Env,
  accountId: string,
  contactId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM account_contacts WHERE id = ? AND account_id = ?")
    .bind(contactId, accountId)
    .run();
}

export async function importPrivateContactList(
  env: Env,
  accountId: string,
  input: { name: string; contacts: PrivateContactInput[] },
) {
  const listName = normalizeListName(input?.name);
  const contacts = normalizeImportedContacts(input?.contacts);
  const now = Date.now();
  const listId = randomId();
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < contacts.length; i += 200) {
    const rows = contacts.slice(i, i + 200).map((contact) => ({ id: randomId(), ...contact }));
    statements.push(
      env.DB.prepare(
        `
      INSERT INTO account_contacts (id, account_id, email, name, created_at, updated_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.email'), json_extract(value, '$.name'), ?, ?
      FROM json_each(?) WHERE 1
      ON CONFLICT(account_id, email) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE account_contacts.name END,
        updated_at = excluded.updated_at
    `,
      ).bind(accountId, now, now, JSON.stringify(rows)),
    );
  }

  statements.push(
    env.DB.prepare(
      `
    INSERT INTO account_contact_lists (id, account_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, name) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at
  `,
    ).bind(listId, accountId, listName, now, now),
  );

  statements.push(
    env.DB.prepare(
      `
    DELETE FROM account_contact_list_members
    WHERE account_id = ?
      AND list_id = (
        SELECT id FROM account_contact_lists
        WHERE account_id = ? AND name = ? COLLATE NOCASE
      )
  `,
    ).bind(accountId, accountId, listName),
  );

  for (let i = 0; i < contacts.length; i += 200) {
    const emails = contacts.slice(i, i + 200).map((contact) => contact.email);
    statements.push(
      env.DB.prepare(
        `
      INSERT OR IGNORE INTO account_contact_list_members (account_id, list_id, contact_id, created_at)
      SELECT ?, l.id, c.id, ?
      FROM account_contact_lists l
      JOIN account_contacts c ON c.account_id = l.account_id
      WHERE l.account_id = ?
        AND l.name = ? COLLATE NOCASE
        AND c.email IN (SELECT value FROM json_each(?))
    `,
      ).bind(accountId, now, accountId, listName, JSON.stringify(emails)),
    );
  }

  await env.DB.batch(statements);
  const importedList = await env.DB.prepare(
    "SELECT id FROM account_contact_lists WHERE account_id = ? AND name = ? COLLATE NOCASE",
  )
    .bind(accountId, listName)
    .first<{ id: string }>();
  if (!importedList) throw new Error("Den sparade listan kunde inte läsas tillbaka");
  const data = await listPrivateContacts(env, accountId);
  return { ...data, importedListId: importedList.id };
}

export async function deletePrivateContactList(
  env: Env,
  accountId: string,
  listId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM account_contact_lists WHERE id = ? AND account_id = ?")
    .bind(listId, accountId)
    .run();
}
