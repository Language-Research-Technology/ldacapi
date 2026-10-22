-- CreateTable
CREATE TABLE "oidc_payload" (
    "model" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "grantId" TEXT,
    "userCode" TEXT,
    "uid" TEXT,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "oidc_payload_pkey" PRIMARY KEY ("model","id")
);

-- CreateTable
CREATE TABLE "oidc_signing_key" (
    "kid" TEXT NOT NULL,
    "jwk" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oidc_signing_key_pkey" PRIMARY KEY ("kid")
);

-- CreateIndex
CREATE INDEX "oidc_payload_grantId_idx" ON "oidc_payload"("grantId");

-- CreateIndex
CREATE INDEX "oidc_payload_model_userCode_idx" ON "oidc_payload"("model", "userCode");

-- CreateIndex
CREATE INDEX "oidc_payload_model_uid_idx" ON "oidc_payload"("model", "uid");
