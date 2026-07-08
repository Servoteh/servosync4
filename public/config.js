// Opcioni RUNTIME override za API base URL. Učitava se PRE aplikacije (vidi
// src/app/layout.tsx) i, ako postavi window.__SERVOSYNC_API_URL__, ta vrednost
// pobeđuje automatsko izvođenje iz adrese u browseru (vidi src/api/client.ts).
//
// PODRAZUMEVANO NE RADI NIŠTA — front sam bira gde je API:
//   • otvoreno preko Cloudflare-a → https://api.servosync2.servoteh.com/api
//   • otvoreno na LAN-u           → http://<isti-host>:3000/api
//
// Odkomentariši i podesi SAMO ako serviraš front sa mašine RAZLIČITE od backenda,
// ili koristiš poseban LAN hostname/port. Menja se samo POSLUŽENA kopija na LAN
// serveru (out/config.js) — bez ponovnog build-a; Cloudflare kopija ostaje prazna.
//
// window.__SERVOSYNC_API_URL__ = "http://192.168.64.28:3000/api";
