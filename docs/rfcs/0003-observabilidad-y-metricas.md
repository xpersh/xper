# RFC 0003: Observabilidad y métricas

- Estado: borrador
- Fecha: 2026-09-22
- Depende de: [RFC 0001](0001-producto-y-workflow.md) y [RFC 0002](0002-configuracion-multimodelo.md)

## Resumen

`Xper Observability` es el subsistema local que registra la ejecución del
workflow, los agentes, los modelos, las herramientas, los gates y la
intervención humana. Sus datos permiten inspeccionar un run, detectar rework y
comparar perfiles o experimentos sin depender de una transcripción.

SQLite es el almacenamiento local propuesto. El diseño es event-sourced: un
registro append-only contiene la fuente de verdad y varias proyecciones sirven
a la CLI y a una GUI futura.

## Objetivos

- Medir tiempo, coste, tokens, intentos, rework y resultados.
- Reconstruir la línea temporal de un run.
- Comparar modelos y execution profiles.
- Separar actividad de xper de actividad interna de Pi.
- Mantener privacidad y aislamiento entre contexts.
- No afectar a la ejecución si falla la captura de métricas.

## No objetivos

- Almacenar prompts, respuestas o código por defecto.
- Medir productividad humana.
- Asignar una puntuación universal a tareas no comparables.
- Convertir métricas correlacionales en conclusiones causales.
- Hacer obligatoria una plataforma externa de telemetría.

## Jerarquía de ejecución

```text
Xper Run
└── Phase Visit
    └── Assignment
        └── Attempt / Agent Invocation
            ├── Pi Agent Cycles
            ├── LLM Requests
            └── Tool Executions
```

### Definiciones

- **Run:** sesión completa de desarrollo gestionada por xper.
- **Phase visit:** entrada en una fase, incluidas revisitas.
- **Assignment:** unidad lógica entregada a un rol.
- **Attempt:** invocación concreta de un agente para resolver un assignment.
- **Pi agent cycle:** ejecución interna de Pi, incluidos retries o
  continuaciones.
- **LLM request:** llamada concreta a un proveedor.
- **Tool execution:** uso de una herramienta con inicio y fin.

Un attempt comienza cuando el coordinador materializa la asignación y crea el
agente. Finaliza cuando el agente queda settled, falla, es cancelado, expira o
es reemplazado.

Pi puede emitir `agent_end` antes de un retry, una compactación automática o
una continuación. Por ello, xper utiliza `agent_settled` como límite final de
la invocación y conserva `agent_start`, `agent_end` y los eventos de retry como
detalle interno.

Referencias:

- [Eventos de extensiones de Pi](https://pi.dev/docs/latest/extensions)
- [Eventos RPC de Pi](https://pi.dev/docs/latest/rpc)
- [Esquema de telemetría de Pi](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/telemetry-schema.md)

## Fuentes de eventos

### Eventos de dominio de xper

```text
run.started
run.suspended
run.resumed
run.completed
run.failed

phase.entered
phase.exited
phase.revisited

assignment.created
assignment.completed

attempt.started
attempt.settled
attempt.failed
attempt.aborted
attempt.timed_out

gate.evaluated
gate.passed
gate.failed

model.resolved
model.fallback_applied
model.switched

human.wait_started
human.wait_ended
human.intervention

artifact.created
increment.accepted
```

### Eventos adaptados desde Pi

- Ciclo de vida de agente y turn.
- Inicio, actualización y fin de herramientas.
- Uso y coste reportados por el proveedor.
- Retries, errores y compactaciones.
- Cambios de modelo o nivel de razonamiento.
- Estado de mensajes y cola cuando sea relevante.

xper emite el significado del workflow; Pi aporta el detalle del runtime.
Los eventos de `pi-open-agents` se adaptan al vocabulario de xper: una
delegación crea un `attempt`, y el proceso o sesión hijo se correlaciona con su
`assignment`, fase, modelo y perfil efectivo. La base de datos no depende del
formato interno de la extensión; el adaptador traduce esos eventos a un
envelope estable de xper.

## Envelope común

Cada evento usa una envoltura versionada:

```yaml
event_id: 0199...
event_type: attempt.started
schema_version: 1
timestamp_utc: 2026-09-22T12:00:00.000Z
monotonic_time_ms: 184423

run_id: run-123
phase_visit_id: phase-456
assignment_id: assignment-789
attempt_id: attempt-abc

agent_role: implementation.driver
context: company
execution_profile: work

trace_id: trace-123
span_id: span-789
parent_span_id: span-456

payload: {}
```

Los timestamps UTC permiten ordenar actividad persistida. Un reloj monotónico
se utiliza para calcular duraciones sin verse afectado por cambios del reloj
del sistema.

La relación `trace_id` / `span_id` permite representar concurrencia, camino
crítico y relaciones padre-hijo.

## Pipeline

```text
Coordinator events ----+
                       |
Pi session events -----+---> Event Collector ---> SQLite
                       |                         +-- raw events
Pi telemetry ----------+                         +-- projections
                                                 +-- aggregates
```

En la primera integración, el collector recibe también eventos del adaptador
de `pi-open-agents`. Esta fuente se considera un detalle del runtime y no la
fuente de verdad del workflow: si cambia la extensión, los eventos de dominio y
el esquema de SQLite permanecen estables.

El Event Collector es pasivo. Los errores de observabilidad se aíslan y no
cambian el resultado del workflow. La persistencia debe soportar batching,
flush en boundaries importantes y recuperación de inicios sin final después
de un crash.

## Modelo conceptual de datos

| Tabla | Contenido |
| --- | --- |
| `events` | Fuente append-only de todos los eventos |
| `runs` | Estado y resumen de las sesiones de desarrollo |
| `run_active_periods` | Intervalos activos, pausados y esperando al usuario |
| `phase_visits` | Entradas, salidas y revisitas por fase |
| `assignments` | Trabajo lógico asignado a roles |
| `attempts` | Invocaciones físicas de agentes |
| `agent_cycles` | Ejecuciones internas y retries de Pi |
| `model_requests` | Provider, modelo, tokens, coste y latencia |
| `tool_executions` | Herramienta, duración, resultado y error normalizado |
| `gate_results` | Evaluaciones y razones de aceptación o rechazo |
| `profile_snapshots` | Configuración efectiva e inmutable del run |
| `metric_snapshots` | Agregados precalculados para consultas y GUI |

SQLite debe usar migraciones versionadas. El modo de journal y la estrategia
de escritura se decidirán durante la implementación; el objetivo es admitir
lectura concurrente desde la GUI sin bloquear la captura.

## Snapshots de configuración

Cada attempt registra la resolución exacta:

```yaml
role: implementation.driver
model_preset: local-coder
provider: ollama
model: qwen-coder
thinking: medium
context: personal
strategy: balanced
```

Los aliases pueden cambiar en el futuro, pero los runs históricos deben seguir
siendo explicables y reproducibles.

## Tiempo y esfuerzo

No existe una única duración válida:

| Métrica | Definición |
| --- | --- |
| Wall-clock duration | Tiempo natural entre inicio y fin del run |
| Active duration | Wall-clock excluyendo pausas y esperas humanas |
| Agent time | Suma de la duración de todos los agentes |
| Critical-path duration | Cadena de trabajo que determina el tiempo total |
| Provider time | Tiempo esperando respuestas de modelos |
| Tool time | Tiempo consumido por herramientas y verificaciones |
| Human wait time | Tiempo bloqueado esperando una decisión |
| Coordination overhead | Routing, handoffs, gates e integración |

Con dos agentes trabajando diez minutos en paralelo:

```text
Wall-clock duration = 10 minutos
Agent time          = 20 minutos
```

Ambas cifras son correctas y no deben mezclarse.

## Métricas

### Flujo

- Tiempo hasta el primer incremento aceptado.
- Tiempo total hasta la aceptación.
- Tiempo por fase y por visita.
- Número de revisitas.
- Duración del camino crítico.
- Tiempo bloqueado esperando al usuario.

### Agentes

- Invocaciones por rol.
- Attempts por assignment.
- Tasa de éxito al primer intento.
- Duración media y percentiles por rol, preset y modelo.
- Aborts, timeouts y fallos.
- Reemplazos, fallbacks y cambios de modelo.
- Ratio de trabajo inicial frente a rework.

### Modelos

- Tokens de entrada, salida, caché y reasoning cuando estén disponibles.
- Coste por attempt, fase, incremento y run.
- Latencia hasta el primer token.
- Latencia total del proveedor.
- Tool calls por modelo.
- Tasa de aceptación por modelo y rol.
- Coste por incremento aceptado.

### Calidad

- Gates aprobados y rechazados.
- Criterios de aceptación superados.
- Regresiones detectadas.
- Rework solicitado por Verify o Judgment Day.
- Veredicto final.
- Intervenciones humanas necesarias.

### Métricas de portada

1. `time_to_accepted_increment`
2. `cost_per_accepted_increment`
3. `first_pass_acceptance_rate`
4. `rework_ratio`

Definiciones iniciales:

```text
first_pass_acceptance_rate =
  assignments aceptados en el primer attempt
  / assignments aceptados

attempt_rework_ratio =
  attempts posteriores al primero
  / attempts totales

cost_per_accepted_increment =
  coste total atribuible
  / incrementos aceptados
```

Las fórmulas forman parte del esquema versionado. Cambiar una definición crea
una nueva versión de la métrica, no reinterpreta silenciosamente el histórico.

## GUI futura

Vistas previstas:

- Timeline tipo Gantt de fases, agentes, modelos y herramientas.
- Embudo de assignments, attempts y aceptación.
- Comparación de execution profiles.
- Coste y duración por modelo y rol.
- Heatmap de rework entre fases.
- Evolución del first-pass acceptance rate.
- Distribución de fallos, retries y timeouts.
- Camino crítico del run.
- Comparación de experimentos controlados.

Ejemplo de scorecard:

```text
                         Profile A   Profile B
Time to acceptance        42 min      29 min
Attempts                   8           5
First-pass success         50%         80%
Rework loops               3           1
Cost                       $1.90       $3.10
Judgment Day               ACCEPT      ACCEPT
```

## Comparaciones y experimentos

La GUI distingue:

- **Historical trend:** evolución real de un proyecto.
- **Comparable experiment:** mismo snapshot, tarea, criterios, herramientas y
  límites; cambia el perfil o modelo.
- **Non-equivalent runs:** ejecuciones que no deben compararse directamente.

Para un experimento controlado, cada candidato trabaja sobre un workspace
creado desde el mismo snapshot. Se fijan el contexto, los artefactos de entrada,
las herramientas, los límites y el Judge.

Las métricas objetivas —tests, gates, regresiones, tiempo y coste— tienen
prioridad sobre una puntuación subjetiva del Judge.

## Privacidad y contexts

Por defecto se almacena:

- Identificadores de provider y modelo.
- Rol, fase, estado y resultado.
- Duraciones, tokens y costes.
- Nombre de la herramienta.
- Errores normalizados.
- Veredictos y referencias a artefactos.

Por defecto no se almacena:

- Prompts o respuestas completas.
- Código o diffs completos.
- Argumentos y resultados de herramientas.
- Salida de shell.
- Contenido de archivos.
- Headers, tokens o API keys.

Cada context utiliza almacenamiento aislado. La comparación entre `company`,
`personal` o contexts de clientes requiere una acción explícita. La captura de
contenido es opt-in y debe incorporar redacción, retención y borrado.

## Fiabilidad

- La observabilidad no puede detener ni modificar un run.
- Los fallos de persistencia generan un warning y un diagnóstico recuperable.
- Un attempt iniciado sin evento final se marca `interrupted`, no `failed`.
- Los eventos son idempotentes por `event_id`.
- La base de datos incluye versión de esquema y migraciones.
- Se registran las versiones de xper, Pi, workflow y configuration snapshot.
- Los procesos agentes envían eventos al collector central; no coordinan
  escrituras arbitrarias directamente contra SQLite.

## Decisiones pendientes

- Ubicación multiplataforma definitiva de las bases de datos.
- Base por context, por proyecto o ambas mediante particionado.
- Política de retención y compactación del event log.
- Estrategia de recuperación cuando SQLite no está disponible.
- Taxonomía estable de errores y resultados de herramientas.
- Exportación opcional a OpenTelemetry u otros backends.
- Métricas de complejidad que permitan comparar tareas similares sin inducir
  incentivos incorrectos.
