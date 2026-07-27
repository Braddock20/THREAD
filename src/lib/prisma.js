// src/lib/prisma.js — singleton Prisma client
import { PrismaClient } from "@prisma/client";

const prisma = globalThis.__prisma || new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error", "warn"] : ["error", "warn"],
});

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}

export default prisma;