# ServoSync backend (NestJS 11 + Prisma 6). Multi-stage build.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Full node_modules from build stage (includes generated Prisma client and
# any native bindings compiled during npm ci).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/main"]
