/*
  Warnings:

  - Made the column `session_id` on table `Link` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Link" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "tipo" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpCode" INTEGER,
    "responseTime" INTEGER,
    "titulo" TEXT,
    "profundidade" INTEGER,
    "session_id" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Link_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ScanSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Link" ("createdAt", "id", "origem", "session_id", "status", "tipo", "url") SELECT "createdAt", "id", "origem", "session_id", "status", "tipo", "url" FROM "Link";
DROP TABLE "Link";
ALTER TABLE "new_Link" RENAME TO "Link";
CREATE INDEX "Link_session_id_idx" ON "Link"("session_id");
CREATE UNIQUE INDEX "Link_url_session_id_key" ON "Link"("url", "session_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
