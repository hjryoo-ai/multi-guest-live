import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";

// 마이그레이션 전용 단일 커넥션.
const migrationClient = postgres(config.databaseUrl, { max: 1 });

async function main() {
  const db = drizzle(migrationClient);
  console.log("[migrate] applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] done");
  await migrationClient.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
