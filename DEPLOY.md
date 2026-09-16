# Subir Operador a la nube

Objetivo: que el sistema corra **sin tu PC**, y que no cueste nada.

Tres piezas, tres servicios, ninguno con tarjeta:

| Pieza | Dónde | Por qué ahí |
|---|---|---|
| **Base de datos** | Neon (o Supabase) | Es la única verdad. El motor no guarda nada en memoria entre ciclos. |
| **Motor** | GitHub Actions, por horario | No necesita un servidor. Ver abajo. |
| **Panel + API del teléfono** | Vercel | Solo lee la base y responde al APK. |

## Por qué el motor no necesita un servidor

El charter decía que el motor tenía que ser un proceso permanente, por
suscripciones WebSocket. **Eso ya no es cierto y hay que decirlo:** no queda ni
un WebSocket en el código. Todos los adaptadores (DexScreener, GoPlus, Jupiter,
GeckoTerminal, PancakeSwap) son HTTP, y todo el estado —posiciones, escalera,
vigilancia de muerte, órdenes en vuelo— vive en Postgres.

Un ciclo lee la base, decide, escribe y termina. No hay nada que un proceso
permanente pueda sostener entre ciclos, porque no hay nada en memoria.

Eso es lo que permite lo que vino después: **una corrida sostiene el bucle
durante horas y se marca su propio ritmo**. El cron de GitHub resultó ser de
mejor esfuerzo en serio — medido, tres disparos programados en doce horas
contra un `*/15` — así que pedirle puntualidad era pedirle lo que no da. El
workflow pone `OPERADOR_MAX_CYCLES: 120` contra un tope de 350 minutos, y el
cron solo tiene que acertar una vez en ese rato.

Dentro de esa corrida hay **dos cadencias**: un paso de *vigilancia* cada cinco
minutos, que avanza las barras de las posiciones abiertas, y un *escaneo* cada
hora, que es lo caro. Un token que tenés puede rugear en diez minutos; una
oportunidad perdida por una hora es solo una oportunidad perdida.

Dos límites que tenés que conocer **antes** de confiar en esto:

- **El cron de GitHub es de mejor esfuerzo.** Con carga alta una corrida puede
  arrancar diez minutos tarde. En barras de 15 minutos se tolera; en barras de
  1 minuto no serviría.
- **Un workflow programado se apaga solo tras 60 días sin commits** al
  repositorio. Hacé un push, o volvé a activarlo desde la pestaña Actions.

Si algún día querés un demonio de verdad, el mismo Docker que ya está en el
repo corre en Oracle Cloud Always Free (ARM) sin cambiar una línea. La
migración es un deploy, no una reescritura.

---

## Paso 1 — La base de datos (Neon)

1. Entrá a <https://neon.tech>, creá una cuenta con GitHub.
2. **Create project**. Región: la más cercana a vos. Postgres 16 o más.
3. Copiá la **connection string**. Se ve así:

   ```
   postgresql://usuario:contraseña@ep-algo-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   Guardala. La vas a pegar en dos lugares.

No hace falta crear ninguna tabla: el motor corre `schema.sql` solo la primera
vez que arranca.

> Supabase sirve igual. Si lo usás, tomá la cadena de **Connection Pooling**
> (puerto 6543), no la directa.

## Paso 2 — El token de control

Es la única credencial que puede cambiar algo, y solo puede **frenar** el
motor: no puede abrir una orden ni tocar una billetera. Mínimo 24 caracteres, o
el endpoint rechaza todo en vez de aceptar algo adivinable.

Generá uno:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Guardalo. Va en GitHub, en Vercel y en el APK.

## Paso 3 — El repositorio

```bash
git remote add origin https://github.com/TU-USUARIO/operador.git
git push -u origin master
```

**Público o privado — esto importa para el costo:**

| | Minutos de Actions | Corridas largas de ~6h |
|---|---|---|
| Público | ilimitados | entra cómodo |
| Privado | 2.000/mes gratis | **no entra, ni cerca** |

Si lo dejás privado, cambiá el cron a `*/30 * * * *` en
`.github/workflows/engine.yml` y queda alrededor de 1.700 minutos. El `.env`
nunca se sube: está en `.gitignore` y los secretos van aparte.

## Paso 4 — Los secretos del motor

En GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Nombre | Valor |
|---|---|
| `DATABASE_URL` | la cadena de Neon del paso 1 |
| `OPERADOR_CONTROL_TOKEN` | el token del paso 2 |

En la pestaña **Variables** (al lado de Secrets), opcionales:

| Nombre | Para qué | Por defecto |
|---|---|---|
| `OPERADOR_CAPITAL_USD` | capital total del experimento | `1000` |
| `OPERADOR_MAX_POSITIONS` | tope duro de posiciones; **`0` = sin tope, decide el capital** | `0` |
| `OPERADOR_MAX_DCA` | peldaños de DCA por token (la entrada no cuenta) | `5` |
| `OPERADOR_MAX_USD_PER_LEVEL` | tope de USD por peldaño | `15` |
| `OPERADOR_SCAN_MS` | cada cuánto un paso ADEMÁS escanea | `3600000` (1h) |
| `OPERADOR_CYCLE_MS` | cada cuánto ocurre un paso | `300000` (5 min) |
| `OPERADOR_IDLE_HOURS` | horas que una reserva sin operar conserva su ranura | `3` |
| `OPERADOR_MIN_SCORE_EDGE` | puntos que un candidato necesita para quedarse con una ranura vacía | `10` |
| `OPERADOR_GAS_USD` | gas por swap, define el piso mínimo | `0.05` |
| `OPERADOR_MAX_SECURITY_CHECKS` | tokens por cadena con revisión completa por ciclo | `20` |

## Paso 5 — Primera corrida, a mano

Antes de dejarlo solo, mirálo funcionar una vez.

**Actions → engine → Run workflow**.

Abrí el log. Lo que tiene que aparecer:

```
[boot]  {"mode":"paper","chains":"solana,bsc","capitalUsd":1500,"maxPositions":0,...}
[watch] {"positions":5,"bars":1,"opened":9,"released":0,"halted":0,"seconds":41}
[full]  {"positions":14,"bars":1,"opened":0,"released":1,"halted":0,"seconds":187}
```

La línea `[boot]` es la que conviene leer con atención: dice con qué
configuración arrancó de verdad. Si ahí ves un número que no esperabas,
**mirá las Variables del repositorio** — una variable pisa el valor por
defecto del workflow, y ese es el lugar donde más veces se esconde la
diferencia entre lo que creés que configuraste y lo que está corriendo.

Después de `[boot]` no esperes silencio: **cada paso se anuncia**. Si pasan
más de diez minutos sin una línea nueva, ahí sí hay algo trabado.

Si falla en `[boot]`, es la configuración — el motor se niega a arrancar mal a
propósito, porque descubrir un secreto faltante tres horas después, a mitad de
una escalera, es mucho peor que no arrancar.

Después andá a Neon → **SQL Editor** y confirmá que escribió:

```sql
SELECT chain, count(*) FROM scans GROUP BY chain;
SELECT count(*) FROM alerts;
```

## Paso 6 — El panel (Vercel)

1. <https://vercel.com> → **Add New → Project** → importá el repo.
2. **Root Directory**: `dashboard`.
3. Activá **Include files outside of the Root Directory** — es obligatorio: el
   panel importa el dominio y la capa de aplicación desde `src/`, para que los
   números en pantalla salgan de las mismas funciones que corre el motor y no
   de una segunda implementación que algún día va a discrepar.
4. **Environment Variables**, en Production y Preview:

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | la misma cadena de Neon |
   | `OPERADOR_CONTROL_TOKEN` | el mismo token |

5. **Deploy**.

Te queda una URL tipo `https://operador-xxxx.vercel.app`. Abrila: deberías ver
el universo con lo que escaneó el motor en el paso 5.

## Paso 7 — El teléfono

Abrí el APK y poné:

- **Dirección del servidor**: tu URL de Vercel (con `https://`).
- **Token de control**: el mismo del paso 2.

Desde ahí: las notificaciones llegan solas, el botón **PARAR** frena el motor, y
ya no depende de que tu PC esté prendida.

---

## Qué esperar del universo

El motor escanea **las dos cadenas en cada ciclo** y guarda cada escaneo bajo su
propia cadena, así que el panel las muestra juntas.

Medido en vivo, por ciclo:

| Fuente | Solana | BSC |
|---|---|---|
| Listas de Jupiter | 99 | — |
| Pools de GeckoTerminal | 171 | 119 |
| Promocionados de DexScreener | 36 | 4 |
| **Únicos, deduplicado** | **261** | **123** |

Medido en vivo el 14/09/2026: **384 tokens por ciclo entre las dos cadenas**.
El tope es de 300 direcciones por cadena, así que hoy no recorta nada.

Estos números se mueven: en la primera medición Jupiter daba ~220 y
GeckoTerminal 20. Hoy es casi al revés. Por eso hay tres fuentes y no una
preferida — un universo apoyado en un solo proveedor es un universo que se
parte a la mitad el día que ese proveedor cambia de idea. De ahí, los filtros
gratuitos (liquidez, antigüedad, volumen, FDV, lista negra, suplantación)
deciden primero, y solo los sobrevivientes gastan una consulta de seguridad y
una cotización de venta.

**Todos los tokens escaneados aparecen en el panel**, aprobados y rechazados —
un rechazo por seguridad es una bala esquivada y merece verse. El lienzo dibuja
hasta 400 cuerpos (120 en celular) y si hay más lo dice: `+N sin dibujar`.

### El presupuesto de revisiones

Cada token que pasa los filtros gratuitos cuesta **cinco llamadas de red en
serie**, limitadas por tasa: unos 9 segundos en Solana y 6 en BSC. Revisar
todos los sobrevivientes no entra en una barra de 15 minutos.

Por eso `OPERADOR_MAX_SECURITY_CHECKS` (20 por cadena) acota el gasto. Dos
cosas lo hacen honesto:

- **Se gasta en los mejores.** Antes de recortar, los candidatos se ordenan por
  el puntaje de oportunidad calculado con datos de mercado, que no cuesta nada.
  Tomar los primeros que llegaron sería gastar la revisión cara en el token que
  un proveedor puso primero en su lista.
- **Los que no entran se muestran igual**, en el tier **SIN REVISAR** (violeta).
  No como inseguros: los filtros fallan cerrados, así que un token sin examinar
  nunca se opera — pero "todavía nadie lo miró" y "lo miramos y es peligroso"
  son afirmaciones distintas, y pintarlas iguales convierte una cola de espera
  en una acusación.

El ciclo siguiente llega en quince minutos.

Si ves poquitos:

- ¿Estás mirando `/demo`? Esa página tiene 30 tokens **sintéticos** y lo dice
  arriba. La real es `/`.
- ¿Corrió el motor al menos una vez? Sin un escaneo el universo está vacío.
- ¿`OPERADOR_CHAIN` dice `solana,bsc`? Con una sola cadena ves una sola.

## Cuánto cuesta

| Servicio | Plan | Límite real |
|---|---|---|
| Neon | Free | 0.5 GB. El log de avisos es lo único que crece. |
| GitHub Actions | Free | ilimitado en repo público; 2.000 min/mes en privado |
| Vercel | Hobby | 100 GB de tráfico; un panel personal no se acerca |

Cero dólares. Y vale decirlo sin vueltas: un tier gratuito puede ser recortado
o apagado por decisión de otro. Durante la fase de papel eso no cuesta nada,
porque no hay dinero en juego. **Antes de poner capital real, mové el motor a
un VPS pagado (~5 USD/mes).** Contra un sistema que mueve plata, ese no es un
costo que valga la pena optimizar.

## Si algo se rompe

| Síntoma | Dónde mirar |
|---|---|
| El panel dice "No se puede leer el estado" | `DATABASE_URL` en Vercel |
| El universo está vacío | ¿corrió `engine` en Actions? mirá el log |
| El botón PARAR dice "Rechazado" | el token del APK no coincide con el de Vercel |
| "Datos congelados" en el panel | Vercel no llega a la base; mirá los logs de la función |
| El APK dice "motor en silencio desde ..." | el workflow dejó de correr — ¿se apagó por los 60 días? |
| Actions dejó de correr solo | GitHub apaga los cron tras 60 días sin commits |

El APK avisa por su cuenta cuando el motor se calla: un motor muerto y un motor
sin nada que hacer se ven idénticos desde afuera, y ese es exactamente el fallo
que más caro sale.
