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

// Opcioni RUNTIME override za label-proxy (termalna štampa nalepnica, kiosk).
// Podrazumevano se koristi http://localhost:8765/print (proxy je LOKALNI na svakom
// pogonskom terminalu — servoteh-plan-montaze/tools/label-proxy → TCP 9100 na TSC ML340P).
// Postavi SAMO ako proxy sluša na drugom portu/hostu na tom terminalu:
//
// window.__SERVOSYNC_LABEL_PROXY_URL__ = "http://localhost:8765/print";

// Kapijski QR kiosk prisustva (JAVNA ruta /kiosk-prisustvo, F2 pilot). Front NEMA
// Supabase kredencijale u bundle-u, pa se punch endpoint podešava OVDE — po
// tabletu na kapiji (bez rebuild-a). URL pokazuje na živu edge funkciju
// `kiosk-punch` na sy15; APIKEY je Supabase anon (Kong gateway ga traži).
// Device key (x-kiosk-key) se unosi na samom kiosku i čuva u localStorage.
// (TODO(BE): kad zaživi NestJS proxy /v1/kadrovska/kiosk/punch, ovo više ne treba.)
//
// window.__SERVOSYNC_KIOSK_PUNCH_URL__ = "https://<sy15-supabase-host>/functions/v1/kiosk-punch";
// window.__SERVOSYNC_KIOSK_PUNCH_APIKEY__ = "<supabase-anon-key>";
