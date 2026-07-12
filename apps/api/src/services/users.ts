import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

export async function createUser(nickname: string) {
  const [row] = await db.insert(users).values({ nickname }).returning();
  return row!;
}

export async function getUser(id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}
