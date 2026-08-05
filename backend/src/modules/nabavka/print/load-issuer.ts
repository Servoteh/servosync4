import type { PrismaService } from "../../../prisma/prisma.service";
import type { IssuerInfo } from "./doc-format";

/**
 * Podaci firme-izdavaoca za zaglavlje štampe.
 *
 * Dokumenti nabavke nemaju `companyId` (za razliku od fakture), pa se uzima
 * PRIMARNA firma (najmanji id). Kad tabela `companies` nije popunjena, vraća se
 * fallback sa `missing: true` — zaglavlje tada ispisuje „(podaci firme nisu
 * podešeni)" umesto da tiho odštampa „Servoteh d.o.o." bez PIB-a i računa.
 */
export async function loadPrimaryIssuer(
  prisma: PrismaService,
): Promise<IssuerInfo> {
  const company = await prisma.company.findFirst({
    orderBy: { id: "asc" },
    select: {
      companyName: true,
      address: true,
      city: true,
      postalCode: true,
      taxId: true,
      registrationNumber: true,
      bankAccount: true,
      phone: true,
      email: true,
    },
  });
  if (!company) {
    return {
      companyName: "Servoteh d.o.o.",
      address: null,
      city: null,
      taxId: null,
      registrationNumber: null,
      bankAccount: null,
      phone: null,
      email: null,
      missing: true,
    };
  }
  return { ...company, missing: false };
}
