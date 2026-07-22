// Static export (output: "export") zahteva generateStaticParams za [id] rute
// (incident 21.07: [id] bez ovoga obori frontend export). Detalj se učitava
// klijentski (useParams + fetch), pa je dovoljan placeholder param; realni
// id-jevi se rezolvuju u runtime-u na klijentu. Obrazac: nabavka/[id]/layout.tsx.
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function ZahtevIdLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
