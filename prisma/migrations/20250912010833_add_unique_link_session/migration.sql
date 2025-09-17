/*
  Warnings:

  - A unique constraint covering the columns `[url,session_id]` on the table `Link` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Link_url_session_id_key" ON "Link"("url", "session_id");
