# Arquitectura de la aplicación

La entrada al proceso es el CLI. El CLI expone dos interfaces: comandos de
terminal y un bridge JSONL que recibe peticiones de los adaptadores. Ambas
invocan casos de uso de `xper-application`.

```mermaid
flowchart LR
    Pi[Adaptador de Pi] --> Bridge[Bridge JSONL]
    Terminal[Comandos CLI] --> Cases[Casos de uso]
    Bridge --> Cases
    Cases --> Domain[Dominio]
    Cases --> Ports[Puertos]
    SQLite[SQLite] -. implementa .-> Ports
    Local[Archivos, instalación, reloj e IDs] -. implementa .-> Ports
```

Las flechas continuas muestran llamadas. Las implementaciones dependen de los
contratos del core. `composition.rs` crea y conecta las dependencias concretas.

## Mapa para leer el código

| Responsabilidad | Ubicación | Contenido |
| --- | --- | --- |
| Entrada al proceso | `crates/xper-cli/src/main.rs` | Argumentos y código de salida |
| Transporte del bridge | `crates/xper-cli/src/bridge/mod.rs` | Framing, handshake, sesiones y heartbeat |
| Traducción RPC | `crates/xper-cli/src/bridge/workflow.rs` | JSON → petición tipada → resultado → JSON |
| Presentación CLI | `crates/xper-cli/src/status.rs`, `setup.rs` | Texto/JSON y confirmación por terminal |
| Composición | `crates/xper-cli/src/composition.rs` | Apertura de SQLite y recursos de una sesión |
| Adaptadores locales | `crates/xper-cli/src/infrastructure/` | Reloj, IDs, artefactos e instalación Pi |
| Acciones del sistema | `crates/xper-application/src/use_cases/` | Coordinación de cada operación |
| Dependencias de las acciones | `crates/xper-application/src/ports.rs` | Lecturas, transacciones, evidencia e instalación |
| Vocabulario durable | `crates/xper-application/src/events.rs` | Eventos normalizados y conversión desde el dominio |
| Estado consultable | `crates/xper-application/src/read_models/` | Proyecciones y replay determinista |
| Política de evidencia | `crates/xper-application/src/policies/discovery.rs` | Relación entre visita, assignment, attempt y Brief |
| Reglas del kernel | `crates/xper-domain/src/` | Entidades, máquina de estados y transiciones puras |
| Persistencia | `crates/xper-store-sqlite/` | Transacciones, migraciones, leases y recuperación |

## Casos de uso como API de la aplicación

Cada operación tiene un módulo con una función `execute`. Los comandos de
workflow reciben un `Request` tipado y devuelven un `Outcome`; las consultas
reciben una selección explícita. No reciben JSON, argumentos de terminal ni
una conexión SQLite concreta.

| Entrada | Caso de uso | Resultado |
| --- | --- | --- |
| `run.start` | `start_run` | Iniciar Intake → Discovery o reanudar el run activo de la sesión |
| `assignment.start` | `start_discovery` | Crear assignment/attempt o reintentar un assignment pendiente |
| `attempt.finish` | `finish_attempt` | Registrar resultado, evidencia y cierre del assignment |
| `run.advance` | `advance_run` | Evaluar el gate de Discovery y entrar a Define |
| `run.status`, `xper status` | `get_run_status` | Leer proyección y timeline |
| `xper doctor` | `inspect_installation` | Diagnosticar la instalación sin modificarla |
| `xper init` | `initialize_workspace` | Coordinar preflight, consentimiento y preparación |

Las funciones explicitan las dependencias que necesitan. No hay un contenedor
global de servicios ni un bus de comandos. Añadir una acción consiste en
escribir su coordinación y conectarla a la interfaz que la exponga.

`initialize_workspace` recibe callbacks de presentación y consentimiento.
Decide cuándo invocarlos y cuándo permitir escrituras; el CLI decide cómo
mostrar los checks y cómo leer la respuesta. El adaptador informa qué fallos
puede reparar, por lo que la aplicación no necesita conocer IDs propios de Pi.

## Puertos y garantías

- `RunReader`: consultar un run, sus eventos, el último run y el vínculo de una
  sesión. `get_run_status` sólo requiere este contrato.
- `RunRepository`: añade commits de límites completos. Crear el run y vincular
  su sesión forman una única operación atómica del puerto.
- `ArtifactReader`: comprobar disponibilidad de evidencia relativa al workspace.
- `Installation`: inspeccionar y preparar el scope seleccionado. Conserva
  archivos válidos y comprueba conflictos de backups antes de escribir.
- `Clock` e `IdGenerator`: contratos existentes del dominio, reutilizados por
  los casos de uso para que sus resultados se puedan reproducir en tests.

Una operación coordina una unidad coherente de persistencia: finalizar un
attempt exitoso registra el resultado, el artefacto y el assignment en el
mismo commit. La consulta devuelve únicamente estado persistido. La sesión
resuelve su run mediante el repositorio, sin mantener otra copia del vínculo
en el bridge.

Las leases, el fallback volátil, la apertura de la base y su cierre pertenecen
al adaptador y al lifecycle del proceso. El bridge añade la información de
durabilidad a su respuesta; los casos de uso no conocen SQLite.

## Qué pertenece a cada bloque

- Una regla sobre estados o transiciones de una entidad pertenece al dominio.
- La coordinación entre estado persistido, evidencia y efectos pertenece a un
  caso de uso. La política de Discovery consulta las relaciones de la proyección;
  la disponibilidad real de sus archivos se consulta a través de un puerto.
- Un evento durable describe un hecho con el vocabulario público de xper. La
  conversión desde eventos del dominio excluye objetivos y evidencia textual.
- Una proyección es un modelo de lectura reconstruible. No es la entidad `Run`
  del dominio ni un repositorio; su replay también valida la consistencia del log.
- Un puerto expresa una necesidad de la aplicación y las garantías que exige.
  Su implementación resuelve los detalles del sistema operativo o del proveedor.
- La interfaz valida la forma externa y traduce errores. La aplicación valida
  la operación para proteger también a futuros clientes que no usen el CLI.

Los errores de aplicación distinguen peticiones inválidas de fallos de una
dependencia y conservan la causa original. El bridge los convierte en los
códigos RPC existentes.

## Cómo ampliar la siguiente vertical

1. Expresar las reglas nuevas en el dominio y sus tests cuando correspondan.
2. Añadir la operación en `use_cases/`, con entrada y resultado explícitos.
3. Usar los puertos existentes o definir uno si aparece una necesidad nueva.
4. Probar la coordinación con dobles de los puertos y reloj/IDs deterministas.
5. Conectar el comando o método RPC y conservar sus pruebas de integración.

No se crean módulos para fases futuras ni una jerarquía de clases por cada
caso de uso. Los adaptadores locales permanecen como módulos del ejecutable
mientras sólo éste los componga; podrán extraerse a otro crate cuando otro
ejecutable los necesite.

El avance durable de Discovery sigue usando la proyección y los eventos de la
primera vertical. Esta refactorización no añade rehidratación de la entidad
`Run` desde el log ni generaliza las transiciones a fases aún no implementadas.
Al ampliar el workflow habrá que resolver esa integración con el kernel y
evitar mantener dos conjuntos independientes de reglas de transición.

## Organización de la extensión Pi

La extensión tiene acciones de integración pequeñas. Las reglas de gates y
transiciones siguen en los casos de uso del core Rust.

```text
extension.ts                         compone las dependencias
pi/xper-command.ts                   traduce /xper y presenta resultados
pi/xper-delegate.ts                  registra la tool y presenta su resultado
  → actions/delegate-discovery.ts    coordina una delegación local
      → bridge/xper-client.ts        invoca operaciones tipadas de xper
      → discovery/delegate.ts        ejecuta Pi y normaliza su resultado
      → discovery/artifacts.ts       guarda el Brief sin sobrescribirlo
```

`delegateDiscovery` recibe funciones de ejecución y escritura, un cliente de
workflow y un callback opcional de observaciones. Se puede probar sin procesos,
archivos ni API de Pi. Crea el assignment mediante el core, ejecuta el agente,
guarda la evidencia y comunica el resultado. Tras un éxito solicita el avance y
devuelve la fase indicada por el core, incluido un gate bloqueado.

Los fallos locales de ejecución o escritura producen un resultado fallido; una
cancelación se conserva como tal. Un Brief vacío no produce un éxito y la ruta
del artefacto sólo se devuelve después de guardarlo. Si falla el bridge al
registrar el resultado o avanzar, el error se propaga sin inventar otro
resultado ni reintentar una mutación cuyo commit podría haberse realizado.

`XperClient` ofrece `startRun`, `startAssignment`, `finishAttempt`, `advanceRun`
y `getRunStatus`. Valida las respuestas y las correlaciones de assignment y
attempt antes de entregarlas al consumidor; conserva los errores RPC originales.
Los campos adicionales se admiten para permitir evolución compatible. En el
estado sólo se tipan y validan los campos de proyección que utiliza la extensión;
la timeline permanece opaca y no se reconstruyen reglas del dominio en TypeScript.

`BridgeClient` conserva el transporte JSONL y el handshake. `XperSession` conserva
la conexión, el lifecycle y el último estado tipado. Las acciones no importan
implementaciones de procesos, archivos ni registros de Pi. No necesitan un
contenedor de servicios ni una segunda jerarquía de dominio/aplicación.

## Verificación

`npm run check` ejecuta formato, lint, límites arquitectónicos, typecheck y tests.
Las reglas de `scripts/check-boundaries.mjs` comprueban las dependencias entre
crates y detectan I/O o transporte JSON/RPC dentro de aplicación, construcción
de eventos de workflow desde el CLI e imports de implementaciones fuera de la
composición o infraestructura. En la extensión comprueban que las acciones
reciban sus dependencias de I/O y que las operaciones de workflow se invoquen
mediante el cliente tipado. Son comprobaciones estáticas de convenciones,
no un análisis completo de Rust.

Los tests de aplicación no arrancan SQLite, procesos ni Pi. Los tests de SQLite
verifican sus garantías transaccionales y de recuperación; los del CLI y del
adaptador comprueban que las interfaces públicas siguen funcionando.
