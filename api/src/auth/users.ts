import type { Queryable } from '../db/pool.js';
import type { PublicUser, Role } from './types.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  merchant_id: string | null;
  merchant_name: string | null;
}

export interface UserWithHash extends PublicUser {
  passwordHash: string;
}

const SELECT_USER = `
  SELECT u.id, u.email, u.password_hash, u.role, u.merchant_id, m.name AS merchant_name
  FROM users u
  LEFT JOIN merchants m ON m.id = u.merchant_id`;

function toUser(row: UserRow): UserWithHash {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    passwordHash: row.password_hash,
  };
}

export function toPublicUser({ passwordHash: _passwordHash, ...user }: UserWithHash): PublicUser {
  return user;
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserWithHash | null> {
  const { rows } = await db.query<UserRow>(`${SELECT_USER} WHERE u.email = $1`, [email]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserWithHash | null> {
  const { rows } = await db.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}
