-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."shopify_sessions" (
    "id" VARCHAR(255) NOT NULL,
    "shop" VARCHAR(255) NOT NULL,
    "state" VARCHAR(255) NOT NULL,
    "isOnline" BOOLEAN NOT NULL,
    "scope" VARCHAR(1024),
    "expires" INTEGER,
    "onlineAccessInfo" VARCHAR(255),
    "accessToken" VARCHAR(255),

    CONSTRAINT "shopify_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shopify_sessions_migrations" (
    "migration_name" VARCHAR(255) NOT NULL,

    CONSTRAINT "shopify_sessions_migrations_pkey" PRIMARY KEY ("migration_name")
);
