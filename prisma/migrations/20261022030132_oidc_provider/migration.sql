-- CreateTable
CREATE TABLE "oidc_payload" (
    "model" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "grantId" TEXT,
    "uid" TEXT,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "oidc_payload_pkey" PRIMARY KEY ("model","id")
);

-- CreateIndex
CREATE INDEX "oidc_payload_grantId_idx" ON "oidc_payload"("grantId");

-- CreateIndex
CREATE INDEX "oidc_payload_expiresAt_idx" ON "oidc_payload"("expiresAt");

-- CreateIndex
CREATE INDEX "oidc_payload_model_uid_idx" ON "oidc_payload"("model", "uid");
