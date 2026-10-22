-- CreateTable
CREATE TABLE "user" (
    "sub" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "givenName" TEXT,
    "familyName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("sub")
);
