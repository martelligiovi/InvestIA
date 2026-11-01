# Gravatar from User Scanner
Branch: feat/profile-enrichment

## Specs
S1. “si lo encuentra user scan, lo active directamente automáticamente Como yo te indiqué en mi diagramita”
S2. “user-scan -> 36 semillas random |-> perfil de Gravatar-> accion buscar datos del perfil gravatar -> 3 semillas”
S3. “no se ejecute grabatar hasta que user scan no responda. En caso de que lo encuentre lo ejecuta de manera automática desde la rama de user scan. En caso de que no lo encuentre user scan, ahí sí tira la propuesta. Quieres buscarlo por gravatar. Eso es una "comilla". Hazlo como sea que esté implementado ya el tema de la decisión de ejecutar una acción.”
S4. “Usar el email inicial”
S5. “Respetar el modo manual”
S6. “quiero que vos realices el testeo de esto que funcione con [owner test email, redacted], y ajustes si no funciona”
S8. “Entonces que deje de ser temporal porque para mí está bien una vez que todo eso continúa hasta tirar PR a main porque lo último que vi funciona bien.” / “si, Cuando tengan la imagen lista, yo la pruebo.”
S9. “Proponer, no ejecutar (Recomendado)” — a Gravatar finding for a different discovered email: “Se ejecuta solo para tu email; para el email descubierto se crea una propuesta que aprobás vos.”
S7. “La lógica es la siguiente: se agobran todas las semillas de un resultado cuando no desemboca en otra acción. Este caso sí desemboca en otra acción, solo la de la existencia de la semilla de Gravata. Es decir que no debería salir en la acumulación de arriba, en las 36, porque serían 35 semillas que no tienen la acción, más una que sí tiene una acción.”

## Tasks
T1 [S1-S5] done — Registrar especificación y decisiones; inline; commit pending.
T2 [S1,S3-S5] blocked — Implementar encadenamiento durable y propuesta con pruebas; independent proof unavailable and unresolved historical/validation findings; commit pending.
T3 [S2,S3] Actualizar visualización y documentación; inline; commit pending.
T4 [S1-S7] Verificar riesgos, pruebas y cambios; independent verifier and inline checks; commit pending.
T5 [S6] done — Ejecutar prueba real autorizada en entorno aislado; inline; commit pending.
T6 [S7] done — Corregir agrupación de observaciones del mismo perfil con acción; inline; commit pending.
T7 [S1,S3] done — Resolver hallazgos de validación de email y propuestas históricas con pruebas; inline; commit pending.
T10 [S9] done — Proponer (no ejecutar) Gravatar para emails descubiertos distintos; inline.
T8 [S1-S9] in_progress — Verificación independiente en Docker aislado y PostgreSQL de prueba; verifier; commit pending.
T9 [S8] pending — Commit, imagen candidata desde el commit exacto, push y PR a main; inline.

## Log
L1. ¿no sería más lógico que, por ejemplo, en la investigación test aparece como confirmed la semilla de Gravatar y, al ser esa semilla que existe, habilita la búsqueda en el
 perfil de Gravatar? Es decir que parta desde la búsqueda de user scan y no como una acción particular. ¿Se entiende lo que digo?

 user-scan -> 36 semillas random
           |-> perfil de Gravatar-> accion buscar datos del perfil gravatar -> 3 semillas
Me parece que, si lo encuentra user scan, lo active directamente automáticamente Como yo te indiqué en mi diagramita.  En caso contrario lo tenga que activar yo (Y obviamente que
 sí. Lo activo automáticamente por culpa de User Scan. No me lo propongas, hazlo aparte porque ya lo realicé)
L2. x que no continuar con la misma? ya que sigue siendo la iple de grvatar?
L3. Usar el email inicial
L4. Respetar el modo manual
L5. The existing commit c5ff27d was pushed to origin/feat/profile-enrichment with explicit user authorization. The new work is uncommitted and incomplete. Four focused core tests passed after RED; the manual HTTP endpoint test remains RED (404). Worker and independent verifier could not launch /bin/bash. Assess ran against the parent checkout, not this worktree; no valid worktree assessment was established.
L6. A local worktree shell setting was added; an independent subagent executed `printf 'subagent-shell-ok\n'` with exit 0.
L7. A worker drafted the HTTP endpoint, manual UI control and documentation; its focused tests were not run. Parent focused HTTP and frontend checks passed; full workspace tests failed on old backend queue expectations. Independent review found existing-action lineage and differing email validation concerns.
L8. Lo que debía suceder es que no se ejecute grabatar hasta que user scan no responda. En caso de que lo encuentre lo ejecuta de manera automática desde la rama de user scan. En caso de que no lo encuentre user scan, ahí sí tira la propuesta. Quieres buscarlo por gravatar. Eso es una "comilla". Hazlo como sea que esté implementado ya el tema de la decisión de ejecutar una acción.
L9. After the correction, focused core/backend tests passed (50), frontend tests passed (136), and the workspace build, test, typecheck and git diff --check completed successfully. Independent verifier reported possible accepted-email validation mismatch and delayed presentation of historical proposals, but did not run its tests because isolated scratch was disallowed; independent proof is unavailable. Previous native assess targeted the wrong checkout. No commit or push of new work; candidate image has not been rebuilt or accepted.
L10. quiero que vos realices el testeo de esto que funcione con [owner test email, redacted], y ajustes si no funciona
L11. Sí, ejecutar la prueba real — confirmed target [owner test email, redacted] and authorized User Scanner loud modules/cross-scan and Gravatar as applicable in an isolated investigation.
L12. Background job job-7 built isolated Compose project investia-gravatar-live-20261101 with ephemeral loopback ports and separate volumes. Existing investia-profile stack is untouched. Image ID sha256:4c84682d2595a0149b104a8762be5e9842bf19ca811d34c95235c503ff850b62, test API http://127.0.0.1:32771.
L13. Background job job-8 ran the authorized single live workflow using .pi/live-gravatar-check.mjs against that isolated API: PASS; Scanner succeeded with 37 findings, including two Gravatar findings, one linked lookup and one profile observation. Investigation investigation-f01b95ce-3fc1-4429-92b8-b8fc98d687b8. No retry.
L14. Background job job-9 ran .pi/live-gravatar-graph-check.mjs read-only: PASS; 37 Scanner findings, one Gravatar profile observation, three distinct Gravatar seeds, correct linked graph, zero writes/browser errors and unchanged investigation. Browser external requests blocked. This confirms the requested target's positive path only; negative/manual/historical and independent concurrency proof remain separate.
L15. Hay solo una fallita. La lógica es la siguiente: se agobran todas las semillas de un resultado cuando no desemboca en otra acción. Este caso sí desemboca en otra acción, solo la de la existencia de la semilla de Gravata. Es decir que no debería salir en la acumulación de arriba, en las 36, porque serían 35 semillas que no tienen la acción, más una que sí tiene una acción.
L16. Reproduced in isolated browser: group has 36 entries including one Gravatar. Two Scanner observations share the exact Gravatar profile URL, one email/Registered and one username/Found; only the first feeds the Gravatar action.
L17. Focused regression test job-11 observed RED: 36 grouped instead of 35. Correction represents the same explicitly linked Gravatar profile as one visual seed while retaining access to each observation.
L18. Read-only browser job-13 against the saved real investigation and current source: PASS, 35 grouped, no Gravatar in group, one linked seed, related observation accessible, zero writes/errors, investigation unchanged. No new provider queries. Independent reviewer inspected S7 but could not run isolated tests under its scratch policy; no independent execution proof. Frontend job-12 PASS: focused test, typecheck and full suite (137 tests). Running isolated image at :32771 is unchanged and does not contain this grouping correction; browser check used a temporary Vite server with current source. No new commit.
L19. User authorized the exact external scratch directory C:\Users\orang\AppData\Local\Temp\investia-gravatar-verify. Independent verifier reported the directory absent but could not create a genuinely isolated dependency copy: frontend node_modules contains absolute symlinks into the worktree. It did not create the directory or run the three checks. Independent runtime proof remains unavailable; no automatic retry.
L20. Entonces que deje de ser temporal porque para mí está bien una vez que todo eso continúa hasta tirar PR a main porque lo último que vi funciona bien.
L21. si, Cuando tengan la imagen lista, yo la pruebo. — Owner approved running all steps; owner will personally test the candidate image. Merge still requires owner acceptance of that exact image and green CI.
L22. Both review findings reproduced RED (core unusable email target produced no lookup and no proposal; backend legacy conversion returned no claim; frontend showed legacy unlinked queue as runnable). Fixed: unusable email targets fall back to the scanned email; one claim transaction resolves every legacy unlinked Gravatar queue and still claims other eligible work; UI shows "En espera de user-scanner". GREEN focused tests; full build, workspace test, typecheck and diff check passed (job-18). Docs corrected: lookup uses the email the finding reports, else the scanned email. Temporary Vite preview stopped.
L23. The owner test email is redacted in this committed record to avoid publishing it; the verbatim requests are kept in the local session memory.
L24. Delivery strategy: Un solo PR con recorrido ordenado (Recomendado) — owner chose one PR for the whole branch (11+ commits, ~3.2k authored lines) with an ordered review path, one candidate image, squash merge. Slice boundary: whole branch since origin/main e4d642a.
L25. Docker verifier on 7a35c76 did not execute: its policy forbids networked dependency installs. Scratch left at investia-gravatar-verify/probe-43gdblSU. It flagged S4: a Gravatar finding whose target is a different valid email queues the lookup for that discovered email, not the initial email; owner decision requested.
L26. Proponer, no ejecutar (Recomendado) — owner decision for a Gravatar finding on another discovered email. RED observed (lookup ran for the discovered email; mixed-case own email kept the reported casing). Fixed: only the scanned email (case-insensitive match, username or unusable address) queues automatically; another discovered email gets a linked proposal; the scanned email still gets its own proposal when no finding is its own. Core+backend 55/55, core typecheck pass. Docs updated.
L27. Docker verifier on d675dcb: 309 tests passed, 0 skipped (DB-gated tests ran against throwaway PostgreSQL/Neo4j on an internal network), six typechecks and both Python checks passed, VERIFY_ALL_PASSED; hosted CI run 41361085003 Offline checks success on d675dcb. Verifier flagged by inspection that legacy claim conversion could link a historical queue to a Gravatar finding for another discovered email. Reproduced RED (legacy queue was linked and claimed). Fixed with one shared core rule, gravatarFindingTargetsEmail, used by completion and legacy conversion. Core+backend 56/56; full workspace test, typecheck and diff check pass. Candidate d675dcb superseded.
