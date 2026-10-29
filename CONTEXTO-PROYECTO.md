# Contexto del Proyecto — Alpha Herramientas Bot

## Qué es este proyecto
Bot de atención al cliente con IA para Alpha Herramientas (alphaherramientas.cl), una tienda chilena online de herramientas profesionales (DeWalt, Milwaukee, Stanley, Bosch, Diablo). Responde automáticamente en WhatsApp, Instagram, Facebook Messenger y TikTok.

## Stack técnico
- **Runtime:** Node.js + Express
- **IA:** Claude Haiku 4.5 (API de Anthropic) — modelo rápido y económico
- **Catálogo:** Jumpseller REST API (la tienda está en Jumpseller)
- **WhatsApp:** Meta Cloud API (coexistencia con WhatsApp Business App)
- **Instagram + Facebook:** Meta Graph API / Messaging API
- **TikTok:** ManyChat Pro con webhook externo que apunta a este bot
- **Hosting:** Railway (plan Hobby $5/mes)
- **Presupuesto total:** ~$45 USD/mes para ~4,000 clientes atendidos

## Arquitectura
```
WhatsApp / Instagram / Facebook → Meta Webhook → POST /webhook → askClaude() → respuesta
TikTok → ManyChat → POST /manychat → askClaude() → respuesta JSON a ManyChat
```

Todos los canales comparten la misma lógica de IA. El bot:
1. Recibe un mensaje del cliente
2. Busca productos relevantes en el cache de Jumpseller (se refresca cada 15 min)
3. Arma un prompt con el catálogo filtrado + la pregunta del cliente
4. Llama a Claude Haiku 4.5 con prompt caching
5. Envía la respuesta de vuelta por el mismo canal

## Variables de entorno necesarias
- ANTHROPIC_API_KEY — API key de Anthropic (console.anthropic.com)
- META_ACCESS_TOKEN — Token permanente de Meta (System User)
- WHATSAPP_PHONE_ID — Phone Number ID del WhatsApp Business
- WEBHOOK_VERIFY_TOKEN — String random para verificar webhook de Meta
- JUMPSELLER_LOGIN — Login key de la API de Jumpseller
- JUMPSELLER_TOKEN — Auth token de Jumpseller (32 caracteres)
- MONTHLY_AI_BUDGET — Límite de gasto mensual en USD para Claude (default: 15)

## Endpoints
- GET /webhook — Verificación de Meta (responde hub.challenge)
- POST /webhook — Recibe mensajes de WhatsApp, Instagram y Facebook
- POST /manychat — Recibe mensajes de TikTok vía ManyChat External Request
- GET / — Health check con estado del bot
- GET /stats — Estadísticas de gasto de IA y cache

## Qué necesito que hagas
1. Sube este proyecto como repositorio PRIVADO a mi GitHub
2. NO subas archivos .env ni node_modules (ya hay .gitignore)
3. El repo se llama "alpha-herramientas-bot"
4. Después de subirlo, lo conectaremos a Railway para deploy

## Notas importantes
- Las credenciales de Jumpseller que se usaron en desarrollo deben resetearse (el cliente generará nuevas)
- La API key de Anthropic es mía por ahora, después se cambia a la del cliente
- El bot tiene un límite de gasto mensual programado — si se excede, responde con mensaje genérico en vez de llamar a Claude
- El catálogo se cachea en memoria y se refresca cada 15 minutos desde la API de Jumpseller
- La búsqueda de productos es fuzzy (normaliza acentos, busca por múltiples términos)
