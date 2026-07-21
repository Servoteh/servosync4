// Static export (output: "export") zahteva generateStaticParams za [id] rute.
// Detaljni prikaz se učitava klijentski (useParams + fetch), pa je dovoljan
// placeholder param; realni id-jevi se rezolvuju u runtime-u na klijentu.
export function generateStaticParams() {
  return [{ id: "_" }];
}


export default function FakturisanjeIdLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
