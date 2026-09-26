# Desarrollo de xper con agentes

Estas instrucciones se aplican a todo el repositorio. Lee también las
instrucciones locales indicadas abajo antes de modificar su área, aunque tu
harness no cargue automáticamente los `AGENTS.md` de subdirectorios.

## Antes de editar

1. Revisa `git status` y conserva los cambios existentes ajenos a tu tarea.
2. Lee el [README](README.md) para conocer el estado ejecutable del producto.
   La primera vertical llega de Discovery a Define; el backlog no describe
   necesariamente funcionalidades implementadas.
3. Localiza la responsabilidad del cambio y lee sólo las guías que le afectan:

   | Área | Instrucciones y referencia |
   | --- | --- |
   | Core Rust y CLI (`crates/`) | [crates/AGENTS.md](crates/AGENTS.md) y [arquitectura del core](docs/architecture.md) |
   | Adaptador Pi (`adapters/pi/`) e integración de `.pi/` | [adapters/pi/AGENTS.md](adapters/pi/AGENTS.md) y [arquitectura de Pi](adapters/pi/docs/architecture.md) |
   | Contrato entre procesos (`schemas/`, `fixtures/`, `xper-protocol`) | [Protocolo público](schemas/README.md), [fixtures](fixtures/README.md) y las instrucciones de los productores y consumidores afectados |
   | Una tarea del backlog | Su archivo en [docs/tasks/](docs/tasks/README.md), incluido su estado y criterios de aceptación |

Las guías de arquitectura describen la organización actual; los RFC explican
las decisiones y la dirección prevista. Si encuentras una discrepancia con el
código, señálala y resuélvela dentro del alcance del cambio. No implementes fases
futuras sólo porque aparezcan en un RFC.

Si existe `.codegraph/`, consulta primero `codegraph_explore` o
`codegraph explore "<pregunta o símbolo>"` para localizar o entender código.
Si no existe, usa `rg`; no generes un índice como parte de otra tarea.

## Reglas de implementación

- El core gobierna el workflow. Los adaptadores acceden a él mediante el
  protocolo público y conservan los detalles de cada harness en su paquete.
- Añade comportamiento en el bloque que le corresponde y usa dependencias
  explícitas. No crees contenedores globales, buses de comandos ni módulos
  vacíos para anticipar necesidades futuras.
- Mantén cada comprobación de arquitectura junto a su propietario. Un nuevo
  adaptador debe tener instrucciones, guía y checks propios; si es un workspace
  npm, define `boundaries` para integrarse en el comando conjunto.
- Si cambias un contrato público, revisa conjuntamente schema, fixtures,
  implementación Rust, consumidores afectados y pruebas de compatibilidad.
  Conserva la semántica de errores y versiones o documenta su evolución.
- Una modificación deliberada de los límites debe actualizar la guía y sus
  checks con una justificación. No desactives una regla para hacer pasar código
  que debería vivir en otro módulo.
- No edites salidas generadas (`target/`, `adapters/pi/dist/`, `node_modules/`)
  ni uses el estado local de `.xper/` como fixture. Las pruebas deben trabajar
  con datos sintéticos y recursos aislados, sin credenciales de modelos.

## Verificación y entrega

Los requisitos y la instalación están en [Desarrollo](README.md#desarrollo).
Todos los comandos de estas instrucciones se ejecutan desde la raíz.

- Durante la implementación, ejecuta las pruebas del comportamiento afectado y
  los checks de su área. Añade pruebas cuando cambies comportamiento observable;
  una corrección debe cubrir la regresión que resuelve.
- Antes de entregar cambios de código, dependencias o configuración de build,
  ejecuta `npm run check`: formato, lint, límites de arquitectura, typecheck y
  tests. Es el conjunto de comprobaciones que ejecuta CI.
- Para cambios sólo de documentación, comprueba enlaces, rutas, comandos y
  `git diff --check`; no hace falta repetir toda la suite.
- Actualiza la documentación de las responsabilidades o contratos que cambien.
  Si trabajas sobre una tarea del backlog, mantén su estado y evidencia conforme
  a sus criterios de aceptación.
- Revisa el diff final y explica qué cambió, por qué pertenece a esos módulos
  y qué verificaste. Indica los checks que no pudiste ejecutar y su causa; no
  declares un resultado correcto sin evidencia.

`.pi/agents/xper.md` define el agente que usa el producto. Las instrucciones para
desarrollar este repositorio son estos `AGENTS.md`; son responsabilidades distintas.
