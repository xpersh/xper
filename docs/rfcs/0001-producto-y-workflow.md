# RFC 0001: Producto y workflow de xper

- Estado: borrador
- Fecha: 2026-09-22
- Alcance: definición funcional y conceptual

## Resumen

`xper` es un agente principal y una capa de coordinación para Pi inspirados en
Extreme Programming. Su responsabilidad es convertir una intención de
desarrollo en incrementos pequeños, verificables e integrables mediante un
workflow con contratos, gates y feedback explícito.

xper se presenta al usuario como el agente principal de la sesión, pero no es
solamente una personalidad o un conjunto de prompts. Su extensión mantiene la
máquina de estados, crea y coordina subagentes, prepara su contexto, limita su
autoridad, conserva sus artefactos y decide cuándo el trabajo puede avanzar.

## Objetivos

- Aplicar prácticas XP a un proceso de desarrollo multiagente.
- Reducir el tamaño de los cambios y acortar el feedback.
- Hacer explícitas las condiciones para avanzar o retroceder entre fases.
- Evitar que el contexto completo de una conversación sea el único estado del
  proceso.
- Permitir ejecución supervisada o autónoma sin perder trazabilidad.
- Producir evidencia suficiente para verificar y comparar resultados.

## No objetivos iniciales

- Reemplazar el runtime, los proveedores o las herramientas de Pi.
- Diseñar un gestor generalista de proyectos.
- Mantener agentes permanentes para cada fase.
- Ejecutar trabajo concurrente sobre un mismo workspace sin aislamiento.
- Evaluar la productividad de personas.

## Principios XP como invariantes

- **Test-first:** cada incremento comienza con ejemplos o tests observables.
- **Pair programming:** Driver y Navigator colaboran y pueden intercambiar
  roles.
- **Simple design:** no se acepta complejidad para requisitos hipotéticos.
- **Continuous integration:** los cambios se integran frecuentemente.
- **Refactoring continuo:** forma parte de Implementation, no de una fase
  posterior.
- **Small releases:** se busca el incremento aceptable más pequeño.
- **Collective ownership:** ningún agente posee permanentemente una parte del
  código.
- **Feedback corto:** un gate fallido vuelve a la causa, no a una fase fija.
- **Sustainable pace:** existen límites de coste, contexto, concurrencia,
  intentos y tiempo.
- **Human on the loop:** las decisiones ambiguas, irreversibles o de producto
  pueden requerir intervención humana.

## Flujo

```text
Intake
   |
   v
Discovery <-> Define <-> Design
                         |
                         v
               Breakdown <-> Plan
                         |
                         v
            +-- Implementation <-> Verify --+
            |       por incremento           |
            +---------------------------------+
                         |
                         v
                   Judgment Day
                    /         \
                Rework       Accept
                                |
                                v
                           Learn / Close
```

Las fases son vistas especializadas y gates de conocimiento. No representan
departamentos ni un proceso lineal. El coordinador puede volver a cualquier
fase cuando aparece nueva evidencia.

Ejemplos:

- Un criterio de aceptación ambiguo vuelve a `Define`.
- Una limitación técnica no prevista vuelve a `Design`.
- Una historia demasiado grande vuelve a `Breakdown`.
- Un defecto localizado vuelve a `Implementation`.
- Una solución correcta pero innecesariamente compleja puede volver a
  `Design`.

## Contrato de las fases

| Fase | Pregunta principal | Resultado | Gate de salida |
| --- | --- | --- | --- |
| Intake | ¿Qué se pide y qué autoridad tenemos? | Petición normalizada, repositorio, restricciones y autonomía | El alcance inicial es identificable |
| Discovery | ¿Qué problema queremos resolver? | Evidencia, contexto, riesgos, hipótesis e incógnitas | Las incógnitas críticas están resueltas o declaradas |
| Define | ¿Qué significa que esté terminado? | Objetivo, alcance, no-alcance, criterios y ejemplos | El resultado es observable y comprobable |
| Design | ¿Cuál es la solución más simple viable? | Diseño, interfaces, alternativas, riesgos y decisiones | La solución es viable, comprensible y reversible |
| Breakdown | ¿Cómo obtenemos incrementos pequeños? | Historias verticales, dependencias y casos de prueba | Cada unidad puede implementarse y verificarse aisladamente |
| Plan | ¿Quién hace qué, en qué orden y con qué límites? | DAG de trabajo, parejas, workspaces, presupuestos e integración | No hay conflictos de propiedad ni dependencias ocultas |
| Implementation | ¿Podemos producir el incremento con feedback inmediato? | Código, tests, commits y decisiones locales | Tests locales verdes y cambio integrable |
| Verify | ¿Cumple el contrato sin romper lo existente? | Evidencia independiente de aceptación, regresión y calidad | Todos los criterios tienen evidencia |
| Judgment Day | ¿Deberíamos aceptar realmente este resultado? | Veredicto y recomendación de entrega | `accept`, `accept_with_debt`, `rework`, `reject` o `human_decision` |
| Learn / Close | ¿Qué debe conservar xper para el futuro? | Retrospectiva, patrones, deuda y memoria | Aprendizaje registrado y ejecución cerrada |

## Roles

Los roles son perfiles de responsabilidad. Se materializan como agentes
efímeros cuando el coordinador los necesita.

### Coordinator

- Mantiene la máquina de estados.
- Prepara el contexto mínimo de cada agente.
- Asigna roles, modelos, permisos y workspaces.
- Evalúa contratos de entrada y salida.
- Detecta bloqueos, dependencias y conflictos.
- Decide a qué fase regresar ante un fallo.
- Solicita decisiones humanas cuando corresponde.
- Registra eventos, artefactos y evidencia.

El Coordinator gobierna el proceso, pero no sustituye al resto de roles ni
toma decisiones de dominio basadas únicamente en preferencia propia.

### Roles especializados

| Rol | Responsabilidad |
| --- | --- |
| Explorer | Investigar el dominio, el repositorio y las incertidumbres |
| Product / Customer proxy | Convertir la intención en comportamiento observable |
| Designer | Proponer el diseño mínimo y registrar decisiones |
| Story slicer / Planner | Crear incrementos verticales y el plan de ejecución |
| Driver | Implementar el cambio con test-first |
| Navigator | Cuestionar, revisar y mantener el foco en simplicidad y tests |
| Verifier | Validar independientemente sin corregir el código evaluado |
| Judge | Emitir el veredicto final desde un contexto limpio |

El Judge debe recibir la intención, criterios, diff, decisiones y evidencia,
pero no necesita heredar toda la conversación. Esto reduce el sesgo de
confirmación.

## Conceptos del dominio

| Concepto | Descripción |
| --- | --- |
| Run | Ejecución completa de xper para un objetivo |
| Phase | Estado del workflow |
| Phase visit | Entrada concreta en una fase, incluidas revisitas |
| Increment | Unidad vertical de entrega |
| Assignment | Trabajo lógico asignado a un rol |
| Attempt | Invocación concreta de un agente para un assignment |
| Artifact | Salida versionada de una fase |
| Evidence | Prueba verificable que respalda una afirmación |
| Decision | Elección, alternativas y justificación |
| Gate | Condiciones para avanzar |
| Verdict | Resultado de una evaluación |
| Feedback | Transición explícita hacia una fase anterior |
| Policy | Límites de autonomía, seguridad, coste y calidad |

## Artefactos mínimos

Cada run mantiene un expediente trazable:

1. Discovery Brief.
2. Definition Contract.
3. Design Decisions.
4. Story Map.
5. Execution Plan.
6. Increment Records.
7. Verification Report.
8. Judgment Verdict.
9. Retrospective.

Los agentes se comunican principalmente mediante estos artefactos y eventos
estructurados. Las transcripciones completas no son el contrato entre fases.

## Judgment Day

`Judgment Day` es una evaluación adversarial de aceptación. Debe responder:

- ¿Resuelve el problema definido?
- ¿Existe evidencia para cada criterio de aceptación?
- ¿Se introdujo comportamiento no solicitado?
- ¿La solución es más compleja de lo necesario?
- ¿Las decisiones importantes están justificadas?
- ¿Es segura de integrar o publicar?
- ¿Qué deuda se acepta conscientemente?

Veredictos:

- `ACCEPT`
- `ACCEPT_WITH_DEBT`
- `REWORK_IMPLEMENTATION`
- `REVISIT_DESIGN`
- `REDEFINE`
- `HUMAN_DECISION`
- `REJECT`

## Arquitectura conceptual

- Pi funciona como runtime y TUI de la sesión principal y de los subagentes.
- xper se registra como agente `primary` y el usuario interactúa directamente
  con él dentro de la sesión de Pi.
- Pi es el primer harness soportado, no una dependencia del dominio de xper.
- `pi-open-agents` es la dependencia inicial para seleccionar el agente
  principal y materializar subagentes con su modelo, prompt, herramientas y
  permisos.
- Una extensión TypeScript actúa como adaptador de Pi: comandos, tools, hooks,
  contexto dinámico e integración con la TUI.
- El core independiente implementa el workflow, los gates, el routing, el
  estado durable y el modelo de observabilidad.
- Cada subagente dispone de una sesión propia; xper añade aislamiento de
  workspace cuando el plan permite trabajo concurrente.
- El estado durable pertenece a xper, no a una transcripción.
- Los cambios concurrentes se realizan en worktrees u otros entornos aislados.
- El coordinador integra resultados siguiendo el DAG definido en Plan.

La integración se encapsula detrás de una abstracción propia para poder
sustituir `pi-open-agents` si cambia su API o aparece una alternativa más
madura. La dependencia resuelve la identidad y ejecución de agentes; no debe
convertirse en la fuente de verdad del workflow.

La ejecución normal comienza con `pi --agent xper` o activando `/agent xper`
en una sesión existente. `xper run` no forma parte de la interfaz prevista.
La decisión completa se documenta en
[RFC 0004](0004-integracion-con-pi.md).
La separación entre core, protocolo y adaptadores se documenta en
[RFC 0005](0005-arquitectura-modular.md).

## Decisiones pendientes

- Gates humanos predeterminados para los modos supervisado y autónomo.
- Política exacta de integración y resolución de conflictos.
- Formato y versionado de artefactos.
- Presupuestos iniciales de contexto, coste, tiempo e intentos.
- Criterios para rotar Driver y Navigator.
- Estrategia para identificar el incremento vertical mínimo.
- Contrato definitivo del adaptador que desacopla xper de `pi-open-agents`.
