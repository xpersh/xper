# XP-001: resultado del spike de integración con Pi

- Fecha: 2026-09-22
- Veredicto: **GO condicionado** para Pi y activación primaria; **NO-GO** para
  usar `pi-open-agents` como plano de control durable de las delegaciones.
- Código desechable: [`spikes/pi-integration`](../../spikes/pi-integration/README.md)

## Versiones y entornos probados

| Componente | Versión | Entorno | Resultado |
| --- | --- | --- | --- |
| Pi | `0.85.1` | macOS 26.5.2 arm64, Node `24.18.0` | PASS |
| Pi | `0.85.1` | Linux Debian arm64, Node `24.21.0` | PASS |
| `pi-open-agents` | `0.1.22` | macOS arm64, Pi `0.85.1` | PASS con defectos de error/cancelación |
| Lifecycle en Windows | mismo probe Node/Pi | No había runtime Windows disponible | NO EJECUTADO |

Evidencia durable:

- [`macos-arm64-core.json`](../../spikes/pi-integration/evidence/macos-arm64-core.json)
- [`linux-arm64-core.json`](../../spikes/pi-integration/evidence/linux-arm64-core.json)
- [`macos-arm64-open-agents.json`](../../spikes/pi-integration/evidence/macos-arm64-open-agents.json)

El probe de lifecycle no usa credenciales ni red. Registra un proveedor
determinista que obliga a Pi a ejecutar una tool de otra extensión. El probe de
`pi-open-agents` instala la versión exacta en un `PI_CODING_AGENT_DIR`
temporal y no modifica la instalación real del usuario.

Windows queda como gate obligatorio de XP-005/XP-014. La implementación evita
dependencias POSIX (`process.execPath`, `fileURLToPath`, `spawn` con pipes y
`child.kill()` sin señal explícita), y el mismo `npm run test:core` es
ejecutable en Windows, pero no se considera evidencia runtime hasta correrlo
allí.

## Resultados

### Extensión y proceso hijo

Pi `0.85.1` cargó la extensión TypeScript en RPC, registró el comando
`/spike-status`, dos tools, hooks y un estado de TUI. En `session_start`, la
extensión inició un hijo Node con `stdin/stdout/stderr`, completó
`ready -> ping -> pong` y en `session_shutdown` completó
`shutdown -> shutdown_ack -> exit(0)` sin usar el fallback de terminación.

La misma prueba pasó en macOS y Linux. El proceso se inicia en
`session_start`, no en la factory de la extensión, y el cierre es idempotente,
como exige el lifecycle actual de Pi.

### Visibilidad de tools de otras extensiones

Para la tool `spike_foreign_tool`, registrada por otra extensión, el observador
recibió con el mismo `toolCallId`:

1. `tool_execution_start`
2. `tool_call`
3. `tool_execution_update`
4. `tool_result`
5. `tool_execution_end`

Esto permite observar y correlacionar cualquier tool sin parsear la TUI. Los
hooks son globales al runtime de extensiones, no privados de la extensión que
registró la tool.

### Activación primaria

Con una definición `.pi/agents/xper.md` de `mode: primary`, el arranque con
`--agent xper` funcionó. El primer turno persistió una entrada estructurada
`open-agents-state` con `{ name: "xper" }`. También quedaron registrados
`/agent`, `/agents`, `/agent-search`, `set_agent`, `search_agents` y
`subagent` según la visibilidad de los agentes disponibles.

### Contrato real de pi-open-agents

El código fuente de `0.1.22` reexporta tipos, discovery helpers y
`runSubagent()` desde la raíz. Sin embargo, eso no constituye un contrato
consumible entre paquetes instalados por Pi:

- el paquete no declara un mapa `exports`;
- sus cuatro `peerDependencies` aceptan `"*"`;
- su versión es pre-1.0;
- fue desarrollado contra Pi `0.84.4`, aunque el probe pasó en `0.85.1`;
- una extensión hermana no pudo resolver `import("pi-open-agents")`, aun
  estando el paquete instalado y activo en el mismo Pi.

Una extensión de xper sólo podría usar la API directa declarando su propia
dependencia npm —y por tanto cargando otra copia— o acoplándose a la ruta
interna del package store. Ninguna opción es un límite estable.

### Delegación, errores y cancelación

La delegación exitosa inició un proceso Pi hijo, produjo progreso y terminó
con `status: done`, `exitCode: 0`. Inicio y final se correlacionaron por el
`toolCallId` de Pi.

La prueba reveló dos defectos de contrato en `pi-open-agents@0.1.22`:

- Un hijo que termina con `exitCode: 1` produce
  `details: { status: "error", isError: true }`, pero los eventos
  `tool_result` y `tool_execution_end` exponen `isError: false`. El plugin
  devuelve `isError` dentro del objeto en vez de lanzar; Pi documenta que una
  tool debe lanzar para marcar el resultado como error.
- Una cancelación RPC aceptada justo después de `tool_execution_start` termina
  como `details: { status: "done", isError: false, exitCode: 0, output: "" }`.
  El runner convierte un cierre por señal (`code === null`) en código cero, de
  modo que no existe una señal fiable de cancelación.

Por tanto, observar `details` permite recuperar errores de proceso conocidos,
pero no distinguir de forma segura una cancelación temprana de un éxito vacío.

## Matriz de capacidades

| Capacidad | Estado | Evidencia o límite |
| --- | --- | --- |
| Registrar comandos | Disponible | `/spike-status` aparece en `get_commands` |
| Registrar tools | Disponible | Tool propia y tool ajena ejecutadas |
| Hooks de sesión/agente/tool | Disponible | Eventos JSONL del probe |
| Estado/elemento mínimo de TUI | Disponible | `setStatus` visible también por RPC |
| Proceso hijo por `stdio` | Disponible | PASS macOS y Linux; Windows pendiente |
| Observar tool de otra extensión | Disponible | Cinco eventos con un `toolCallId` |
| Activar `xper` como primary | Disponible | `--agent xper` + `open-agents-state` |
| Delegar a un Pi hijo | Disponible | Éxito real con salida estructurada |
| Importar la instalación activa como librería | Ausente | `Cannot find module 'pi-open-agents'` |
| Iniciar una tool ajena desde `ExtensionAPI` | Ausente | No hay método público `executeTool` |
| Error fiable en el envelope de Pi | Defectuoso | `details.isError=true`, hook `isError=false` |
| Cancelación fiable | Defectuoso | Cancelación observada como éxito vacío |
| Correlation ID de dominio | Ausente | Sólo existe `toolCallId`, generado por Pi |
| Compatibilidad versionada | Ausente | pre-1.0, peers `*`, sin matriz publicada |

## Detección de paquete, versión y scope

El camino reproducible es:

1. Resolver el directorio de usuario con `PI_CODING_AGENT_DIR` o el default de
   Pi.
2. Leer `settings.json` de usuario y `.pi/settings.json` del proyecto para
   conocer fuentes declaradas y pins.
3. Ejecutar `pi list --approve` en un proyecto confiable para obtener recursos
   efectivos de scopes `User` y `Project` y sus rutas resueltas. Sin
   `--approve`, Pi puede ocultar el scope de proyecto.
4. Leer el `package.json` de la ruta resuelta; su `name` y `version` son la
   evidencia de la versión realmente instalada.

`pi list` no ofrece salida JSON en la versión probada. XP-006 no debe tratar su
texto como contrato estable: debe preferir settings + manifiesto resuelto y
encapsular cualquier parsing de `pi list` detrás de un detector versionado.

## Decisión de integración

### GO

- Mantener Pi como runtime interactivo y cargar xper como extensión.
- Usar `pi-open-agents@0.1.22` fijado exactamente para discovery, definición y
  activación del agente primario durante el primer prototipo.
- Usar hooks públicos de Pi para observación; nunca parsear texto de TUI.

### NO-GO

- No importar `runSubagent()` desde la instalación activa de
  `pi-open-agents`.
- No usar el `subagent` tool de `0.1.22` como fuente de verdad para resultado,
  error o cancelación del workflow.
- No exponer tipos de Pi o `pi-open-agents` fuera del adaptador.

### Alternativa concreta

El adaptador de xper debe registrar un tool propio, por ejemplo
`xper_delegate`, con un contrato estructurado que incluya `attemptId`, agente,
task, cwd, modelo y política de sesión. Su executor debe ser propiedad de xper,
iniciar Pi por JSON/RPC, reservar stdout para protocolo, propagar
`AbortSignal`, distinguir `exitCode` de `signal`, y emitir estados terminales
exclusivos `succeeded | failed | cancelled`.

`pi-open-agents` puede seguir proporcionando `/agent`, discovery y el formato
de definiciones, pero no controla el lifecycle durable de attempts.

## Riesgos transferidos

### XP-004

- Definir cancelación como estado terminal explícito y no inferirla del código
  de salida.
- Separar `exitCode`, `signal`, timeout y error de protocolo.
- Mantener stdout exclusivamente para JSONL, stderr para diagnóstico y aplicar
  backpressure/framing por LF.
- Hacer shutdown idempotente y tolerante a carreras entre cierre, cancelación y
  caída del hijo.

### XP-005

- Iniciar el bridge en `session_start` y cerrarlo en `session_shutdown`; nunca
  arrancar recursos en la factory.
- Registrar un `xper_delegate` propio y correlacionar por `attemptId` más el
  `toolCallId` de Pi.
- No confiar en `event.isError` para tools de `pi-open-agents@0.1.22`.
- Ejecutar el probe en Windows antes de aceptar el adapter multiplataforma.
- Detectar colisiones de comandos/tools y mantener la UI opcional en modos sin
  TUI.

### XP-006

- Fijar la tupla compatible inicial a Pi `0.85.1` +
  `pi-open-agents 0.1.22`; cualquier cambio exige reejecutar estos probes.
- Distinguir scope de usuario/proyecto y respetar project trust al diagnosticar.
- Verificar la versión efectiva desde el manifiesto resuelto, no sólo desde la
  cadena declarada en settings.
- Detectar instalaciones duplicadas, managers antiguos y paquetes presentes
  en ambos scopes.
- Mantener `doctor` no destructivo y no instalar/actualizar paquetes sin
  confirmación.

## Referencias primarias

- [Extensiones de Pi](https://pi.dev/docs/latest/extensions)
- [RPC de Pi](https://pi.dev/docs/latest/rpc)
- [Eventos JSON de Pi](https://pi.dev/docs/latest/json)
- [pi-open-agents 0.1.22](https://pi.dev/packages/pi-open-agents)
- [Código fuente de pi-open-agents](https://github.com/andrea-tomassi/pi-open-agents)
