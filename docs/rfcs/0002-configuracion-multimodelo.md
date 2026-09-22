# RFC 0002: Configuración y routing multimodelo

- Estado: borrador
- Fecha: 2026-09-22
- Depende de: [RFC 0001](0001-producto-y-workflow.md)

## Resumen

xper debe permitir que cada rol y fase utilice un proveedor y modelo distinto.
La configuración debe ser reproducible y, al mismo tiempo, separar
credenciales, endpoints y políticas personales, corporativas o de cliente.

La solución propuesta separa cuatro conceptos:

| Concepto | Pregunta que responde |
| --- | --- |
| Context | ¿Con qué identidad y bajo qué política trabajo? |
| Model preset | ¿Cómo se ejecuta un modelo concreto? |
| Strategy | ¿Qué tipo de modelo necesita cada rol? |
| Execution profile | ¿Qué combinación quiero activar ahora? |

Se usa `model preset` en lugar de `model profile` para evitar confundirlo con
un execution profile completo.

## Contexts como frontera de seguridad

Un context representa una frontera de:

- Credenciales.
- Catálogo de proveedores y modelos.
- Endpoints permitidos.
- Clasificación de datos.
- Política de fallbacks.
- Almacenamiento de sesiones y métricas.
- Telemetría y retención.

Ejemplos:

- `personal`
- `company`
- `client-acme`
- `offline`

Un fallback nunca puede cruzar de context implícitamente. Si un modelo
corporativo falla, xper no debe enviar código a una cuenta personal o a un
proveedor externo. Si no queda un fallback válido, el run se bloquea.

## Scopes de configuración

| Scope | Ubicación propuesta | Contenido |
| --- | --- | --- |
| Global | `${XDG_CONFIG_HOME:-~/.config}/xper/config.yaml` | Contexts, presets personales y defaults |
| Proyecto | `.xper/config.yaml` | Workflow y requisitos compartidos |
| Local del proyecto | `.xper/config.local.yaml` | Overrides privados y no versionados |
| Run | CLI o manifiesto del run | Overrides y experimentos temporales |

Precedencia:

```text
CLI / manifiesto del run
    |
    v
.xper/config.local.yaml
    |
    v
.xper/config.yaml
    |
    v
configuración global
    |
    v
defaults de xper
```

Las API keys y los tokens no se almacenan en estos archivos. xper reutiliza
el almacén de credenciales de Pi, variables de entorno o un almacén seguro.

Pi utiliza por defecto `~/.pi/agent/settings.json`, `auth.json` y
`models.json`. Su SDK permite seleccionar modelos por sesión y proporcionar
rutas de credenciales y modelos diferentes. Esto hace posible mantener
runtimes separados por context.

Referencias:

- [Settings de Pi](https://pi.dev/docs/latest/settings)
- [SDK de Pi](https://pi.dev/docs/latest/sdk)
- [Proveedores](https://pi.dev/docs/latest/providers)
- [Modelos personalizados](https://pi.dev/docs/latest/models)

## Model presets

Un model preset identifica una configuración reutilizable de ejecución:

```yaml
model_presets:
  local-coder:
    provider: ollama
    model: qwen-coder
    thinking: medium
    limits:
      max_cost_usd: 0
      timeout_seconds: 900
    fallback:
      - personal-cheap

  personal-cheap:
    provider: openrouter
    model: mimo
    thinking: low
    limits:
      max_cost_usd: 1.00

  company-sol:
    provider: company-openai
    model: sol
    thinking: high
    limits:
      max_cost_usd: 3.00
```

Los nombres de modelo anteriores son ilustrativos. Los identificadores reales
se resuelven contra el catálogo disponible en el momento de configurar o
ejecutar xper.

Un preset no contiene el prompt, las herramientas ni los permisos del rol.
Esos elementos pertenecen al rol o a la política del workflow. Esta separación
permite cambiar el modelo sin cambiar la responsabilidad del agente.

## Lanes y strategies

Una strategy asigna roles a lanes lógicas, no directamente a proveedores:

```yaml
strategies:
  balanced:
    routing:
      discovery.explorer: fast
      define.product: reviewer
      design.designer: reviewer
      breakdown.planner: fast
      plan.planner: reviewer
      implementation.driver: coder
      implementation.navigator: reviewer
      verify.verifier: reviewer
      judgment_day.judge: judge
```

Cada context enlaza esas lanes con presets concretos:

```yaml
contexts:
  company:
    credential_store: company
    policy:
      allowed_providers:
        - company-openai
        - company-vllm
      forbid_external_fallbacks: true
      data_classification: confidential
    bindings:
      fast: company-fast
      coder: company-coder
      reviewer: company-reviewer
      judge: company-sol

  personal:
    credential_store: personal
    policy:
      allowed_providers:
        - ollama
        - openrouter
        - personal-openai
      forbid_external_fallbacks: false
    bindings:
      fast: personal-cheap
      coder: local-coder
      reviewer: personal-reviewer
      judge: personal-sol
```

Así, `balanced` mantiene la misma intención en distintos entornos:

```text
work     + implementation.driver -> company-coder
personal + implementation.driver -> local-coder
```

## Execution profiles

Un execution profile es la unidad que selecciona normalmente el usuario:

```yaml
profiles:
  work:
    context: company
    strategy: balanced

  personal:
    context: personal
    strategy: balanced

  personal-local:
    context: personal
    strategy: local-first
```

Ejemplo de uso:

```bash
xper profile activate work
pi --agent xper
```

El perfil también podrá cambiarse desde la sesión mediante un comando de la
extensión, por ejemplo `/xper profile use personal`. La sintaxis definitiva se
cerrará al diseñar la interfaz interactiva.

## Momento de resolución

La asociación definitiva se realiza justo antes de crear el agente:

```text
pi --agent xper + profile work
        |
        v
context company + strategy balanced
        |
        v
judgment_day.judge -> lane judge
        |
        v
company.bindings.judge -> company-sol
        |
        v
provider/model/thinking exactos
        |
        v
subagente creado mediante pi-open-agents
```

El coordinador registra la resolución en el run. El agente conserva el modelo
resuelto durante el attempt. Si se necesita un fallback después de comenzar,
xper crea un nuevo attempt y registra el handoff; no cambia silenciosamente el
modelo dentro de la misma ejecución.

## CLI conceptual

Inicialización:

```bash
xper init
xper init --global
```

Gestión de contexts, modelos y perfiles:

```bash
xper context create company
xper context create personal

xper model add company-sol --context company
xper model add local-coder --context personal

xper profile create work --context company --strategy balanced
xper profile create personal --context personal --strategy balanced

xper profile set work judgment_day.judge=company-sol
xper profile set personal implementation.driver=local-coder
```

Inspección y diagnóstico:

```bash
xper models list
xper profile inspect work --resolved
xper config show --effective
xper doctor
```

`xper init` debe:

1. Detectar Pi y su versión.
2. Detectar `pi-open-agents` y verificar una versión compatible.
3. Explicar e indicar `pi install npm:pi-open-agents` cuando falte.
4. Verificar que el agente principal `xper` sea descubrible por Pi.
5. Leer los proveedores conocidos.
6. Mostrar los modelos disponibles y autenticados.
7. Adoptar configuraciones locales existentes si el usuario lo desea.
8. Crear contexts y model presets.
9. Elegir una strategy inicial.
10. Configurar fallbacks, límites y políticas.
11. Validar capacidades y credenciales.
12. Mostrar el routing efectivo antes de escribir configuración.

En modo interactivo, `init` puede ofrecer instalar la dependencia después de
obtener confirmación explícita. En modo no interactivo no modifica paquetes:
falla con un diagnóstico accionable y el comando exacto que debe ejecutar el
usuario.

`xper doctor` repite el preflight sin modificar el sistema y diferencia entre:

- `PASS`: Pi, `pi-open-agents`, el agente `xper` y la configuración efectiva
  son compatibles.
- `WARN`: existe una actualización recomendada o una configuración parcial que
  no impide iniciar la sesión.
- `FAIL`: falta Pi, falta `pi-open-agents`, su versión es incompatible o no se
  puede resolver el agente principal.

La versión mínima probada de `pi-open-agents` se declarará en el manifiesto de
compatibilidad de xper. Al ser una dependencia pre-1.0, no se asumirá que una
actualización menor es compatible sin pruebas.

Presets iniciales de estrategia sugeridos:

- `balanced`
- `quality-first`
- `cost-first`
- `local-first`
- `custom`

## Política de routing inicial

La primera versión debe ser determinista:

```text
profile + fase + rol -> preset -> provider/model
```

El routing adaptativo puede añadirse más adelante mediante restricciones como
context window, razonamiento, coste, localidad o soporte de herramientas. No
debe introducirse hasta que las decisiones puedan explicarse y reproducirse.

Recomendación inicial:

| Fase o rol | Tipo de modelo |
| --- | --- |
| Discovery | Rápido y económico |
| Define | Buen razonamiento de producto |
| Design | Alta capacidad para cambios de riesgo |
| Breakdown / Plan | Modelo equilibrado |
| Implementation Driver | Local o económico |
| Navigator | Distinto del Driver cuando sea viable |
| Verify | Independiente del implementador |
| Judgment Day | El modelo más fiable disponible y contexto fresco |
| Coordinator | Estable; no necesita ser el más caro |

## Configuración de empresa

Una organización puede distribuir una política sin credenciales:

```yaml
organization: acme

required_context:
  tags:
    - acme
    - confidential

policy:
  external_providers: forbidden
  judgment_day:
    minimum_reasoning: high
    independent_model: true
```

Cada persona enlaza localmente esas capacidades con sus cuentas y endpoints
autorizados. El repositorio conoce la política, pero no las claves ni las
rutas privadas.

## Invariantes de seguridad y reproducibilidad

- Los secrets no se escriben en configuración versionable.
- Los fallbacks permanecen dentro del context.
- El context activo queda fijado al iniciar el run.
- Cada run conserva un snapshot de la configuración resuelta.
- Cualquier override de CLI queda registrado.
- Los modelos incompatibles con las capacidades requeridas fallan durante el
  preflight.
- Un cambio de modelo después de comenzar genera un nuevo attempt.
- La configuración corporativa no puede degradarse silenciosamente a una
  cuenta personal.

## Decisiones pendientes

- Formato final: YAML, JSON o ambos.
- Convenciones de nombres y namespaces para presets compartidos.
- Cómo distribuir policies corporativas.
- Integración exacta con login y credenciales de Pi.
- Soporte multiplataforma de las rutas globales.
- Esquema de capacidades para routing adaptativo futuro.
