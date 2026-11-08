# Bicha Store Bot

Bot de Discord creado desde cero con la identidad **Bicha**. Incluye una portada profesional, panel separado de Robux, panel separado de Discord Nitro, compras mediante tickets privados, bienvenida, ayuda, prefijo configurable y música.

## Preparación

1. Abre `.env` y rellena `DISCORD_TOKEN`, `CLIENT_ID` y `GUILD_ID`.
2. Edita `src/config.js` con tus precios, métodos de pago, IDs de canales y rol de soporte.
3. En Discord Developer Portal → Bot activa:
   - Server Members Intent
   - Message Content Intent
4. Ejecuta:

```powershell
cd D:\botbri
npm install
npm run deploy
npm start
```

## Paneles

- `/panel principal`: publica la portada con botones para Robux y Nitro.
- `/panel robux`: publica directamente el catálogo de Robux.
- `/panel nitro`: publica directamente el catálogo de Discord Nitro.
- `/help`: ayuda visual navegable.
- `/pedidos`: lista los pedidos abiertos para el staff.
- `/ticket setup`: permite elegir categoría y rol de soporte y publicar el panel. El cliente abre el ticket y, dentro, elige Robux o Nitro y el método de pago o soporte.
- `/prefijo`: cambia el prefijo por servidor.

También funcionan comandos por prefijo, inicialmente `!`: `!help`, `!panel`, `!play`, `!queue`, `!skip`, `!stop`, `!vc` y `!leave`. `!vc` conecta a Bicha al canal de voz hasta que el staff use `!leave` o el bot se reinicie. Al etiquetar a Bicha responde con su prefijo actual.

## Configuración central

Todo lo editable está en `src/config.js`:

- nombre, colores, logo y banner;
- paquetes y precios de Robux;
- planes y precios de Nitro;
- métodos de pago;
- rol de soporte, categoría de tickets y canal de logs;
- canal de bienvenida.

