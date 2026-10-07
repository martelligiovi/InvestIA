export function NotFoundPage() {
  return (
    <section className="document-page" aria-labelledby="not-found-title">
      <p className="eyebrow">PÁGINA NO DISPONIBLE</p>
      <h1 id="not-found-title" className="document-title">No encontramos esta página</h1>
      <p className="document-note">La dirección no corresponde a una sección disponible.</p>
      <a className="text-link" href="#/">Volver al inicio <span aria-hidden="true">←</span></a>
    </section>
  );
}
