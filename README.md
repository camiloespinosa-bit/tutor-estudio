# Tutor de estudio

App personal para estudiar con PDFs: subes un documento, conversas con él y conviertes lo que aprendes en práctica que te ayuda a recordarlo.

Funciona en el computador y en el celular (se instala como app desde el navegador). No necesita servidor: es un sitio estático.

## Qué hace

| Sección | Para qué sirve | Base |
|---|---|---|
| **Biblioteca** | Subir PDFs. El texto se extrae en tu dispositivo. | |
| **Tutor** | Preguntar lo que no entiendes. Responde con base en el PDF y cita la página; tocar la cita muestra el texto original. | |
| **Explícalo** | Explicas un tema con tus palabras y el Tutor te dice qué está bien y qué falta. | Técnica Feynman / autoexplicación |
| **Preguntas** | Preguntas abiertas que respondes sin mirar; el Tutor corrige contra el PDF. Las falladas se guardan como tarjetas. | Práctica de recuperación (Roediger y Karpicke, 2006) |
| **Repaso** | Tarjetas que vuelven en intervalos crecientes según qué tan bien las recordaste. | Práctica espaciada (Cepeda et al., 2006); algoritmo tipo SM-2 |

Dunlosky et al. (2013, *Psychological Science in the Public Interest*) calificaron la práctica de recuperación y la práctica espaciada como las técnicas de estudio de mayor utilidad entre las diez que revisaron.

## Cómo empezar

1. Crea una cuenta en [openrouter.ai](https://openrouter.ai), carga saldo y crea una clave en **Keys**. Ponle un **límite de gasto** a la clave.
2. Abre la app, toca ⚙︎ y pega la clave.
3. Sube un PDF en la Biblioteca.

### Instalarla en el celular

- **iPhone (Safari):** botón Compartir → *Agregar a pantalla de inicio*.
- **Android (Chrome):** menú ⋮ → *Instalar app* o *Agregar a pantalla principal*.

## Costos (aproximados)

Los precios los pone OpenRouter y cambian; verifica en openrouter.ai/models. Al 18 de octubre de 2026, Claude Sonnet 5.5 costaba US$ 2 por millón de tokens de entrada y US$ 10 por millón de salida.

Como referencia, un capítulo de unas 40 páginas son del orden de 20.000 tokens. La primera pregunta sobre ese capítulo cuesta alrededor de US$ 0,04 y las siguientes bastante menos, porque la app usa la caché de prompts de Anthropic. Cada respuesta muestra su costo real debajo; el total lo ves en openrouter.ai → Activity.

## Privacidad

- Tus PDFs, tarjetas y conversaciones se guardan **solo en el navegador de cada dispositivo** (IndexedDB).
- Cuando preguntas algo, se envía el texto del documento (o las páginas relacionadas) a OpenRouter y al proveedor del modelo.
- La clave de OpenRouter se guarda en el navegador. Úsala solo en tus dispositivos.

## Limitaciones actuales

- **No sincroniza entre dispositivos.** Para pasar tus datos del computador al celular: Ajustes → *Exportar copia* y luego *Importar copia* en el otro.
- **PDFs escaneados** (imágenes sin texto seleccionable) no se pueden leer todavía.
- En documentos largos (más de ~160.000 caracteres) el Tutor no lee todo: elige las páginas más relacionadas con tu pregunta por palabras clave, y te dice cuáles leyó.

## Publicarla

Es un sitio estático: sirve la carpeta tal cual en GitHub Pages, Netlify, Vercel o similar. Necesita HTTPS para instalarse como app.

## Estructura

```
index.html, styles.css, app.js   interfaz
js/db.js        almacenamiento local (IndexedDB)
js/docs.js      lectura de PDF y selección de páginas
js/llm.js       conexión con OpenRouter
js/prompts.js   instrucciones del Tutor (edítalas para ajustar su estilo)
js/srs.js       algoritmo de repaso espaciado
sw.js           funcionamiento sin conexión
vendor/         pdf.js 3.11.174, marked 12.0.2, DOMPurify 3.1.6 (con sus licencias)
```

Para probarla en local: `python3 -m http.server` dentro de la carpeta y abre http://localhost:8000.
