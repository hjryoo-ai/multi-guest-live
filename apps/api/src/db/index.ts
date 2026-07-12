import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

// 단일 커넥션 풀. 마이그레이션은 별도 스크립트(migrate.ts)에서 수행.
const client = postgres(config.databaseUrl, { max: 10 });

export const db = drizzle(client, { schema });
export { schema };
export type Db = typeof db;

/** graceful shutdown 용 — 커넥션 풀 종료(진행 중 쿼리 drain, 상한 5초). */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
