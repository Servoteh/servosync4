# Static-export front za LAN / offline pristup — ISTI build kao Cloudflare (out/),
# poslužen kroz nginx. Koristi ga `front-lan` servis u compose-u NA SERVERU
# (vidi docs/DEPLOY.md → „LAN pristup / offline fallback").
#
# API base bira browser u runtime-u (src/api/client.ts): na LAN-u → http://<isti-host>:3000/api,
# pa NEXT_PUBLIC_API_URL ovde nije bitan (samo no-window fallback).

# --- build: proizvede out/ ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: nginx služi statiku ---
FROM nginx:alpine
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80
