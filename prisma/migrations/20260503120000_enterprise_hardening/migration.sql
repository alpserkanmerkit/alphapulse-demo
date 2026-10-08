PRAGMA foreign_keys=OFF;

INSERT INTO "Team" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT 'compliance-default-team', 'AlphaPulse Compliance', 'compliance-default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM "Team" WHERE "slug" = 'compliance-default'
);

INSERT INTO "TeamMembership" ("id", "teamId", "userId", "role", "createdAt")
SELECT
    'membership-default-' || "User"."id",
    (SELECT "id" FROM "Team" WHERE "slug" = 'compliance-default' LIMIT 1),
    "User"."id",
    CASE WHEN "User"."role" = 'USER' THEN 'ANALYST' ELSE "User"."role" END,
    CURRENT_TIMESTAMP
FROM "User"
WHERE NOT EXISTS (
    SELECT 1
    FROM "TeamMembership"
    WHERE "TeamMembership"."teamId" = (SELECT "id" FROM "Team" WHERE "slug" = 'compliance-default' LIMIT 1)
      AND "TeamMembership"."userId" = "User"."id"
);

UPDATE "PortfolioState"
SET "teamId" = (SELECT "id" FROM "Team" WHERE "slug" = 'compliance-default' LIMIT 1)
WHERE "teamId" IS NULL;

DROP INDEX IF EXISTS "PortfolioState_userId_key";
CREATE UNIQUE INDEX "PortfolioState_userId_teamId_key" ON "PortfolioState"("userId", "teamId");

CREATE TABLE "ModelRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT,
    "actorId" TEXT,
    "route" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "modelName" TEXT,
    "promptVersion" TEXT,
    "inputHash" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "failureStage" TEXT,
    "durationMs" INTEGER,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelRun_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ModelRun_createdAt_idx" ON "ModelRun"("createdAt");
CREATE INDEX "ModelRun_teamId_idx" ON "ModelRun"("teamId");
CREATE INDEX "ModelRun_actorId_idx" ON "ModelRun"("actorId");
CREATE INDEX "ModelRun_route_idx" ON "ModelRun"("route");
CREATE INDEX "ModelRun_outcome_idx" ON "ModelRun"("outcome");

PRAGMA foreign_keys=ON;
