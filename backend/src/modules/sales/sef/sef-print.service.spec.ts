import { parseUbl } from "./sef-print.service";

/**
 * Čitanje UBL-a za štampu. Ključno pravilo: parser NIKAD ne baca — SEF ume da
 * vrati krnj ili prazan dokument, a štampa mora da izađe sa napomenom, ne da padne.
 */
const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:mfin.gov.rs:srbdt:2021</cbc:CustomizationID>
  <cbc:ProfileID>urn:cen.eu:en16931:2017.poacc:billing:3.0</cbc:ProfileID>
  <cbc:ID>IF-2026-0001</cbc:ID>
  <cbc:IssueDate>2026-07-20</cbc:IssueDate>
  <cbc:DueDate>2026-08-19</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Promet dobara po ugovoru 118/2026.</cbc:Note>
  <cbc:DocumentCurrencyCode>RSD</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cbc:EndpointID schemeID="9948">101017443</cbc:EndpointID>
    <cac:PostalAddress><cbc:StreetName>Ugrinovački put 12b</cbc:StreetName><cbc:CityName>Dobanovci</cbc:CityName>
      <cac:Country><cbc:IdentificationCode>RS</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>RS101017443</cbc:CompanyID></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>SERVOTEH d.o.o.</cbc:RegistrationName><cbc:CompanyID>17400169</cbc:CompanyID></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyLegalEntity><cbc:RegistrationName>KUPAC a.d.</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:Delivery><cbc:ActualDeliveryDate>2026-07-19</cbc:ActualDeliveryDate></cac:Delivery>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="RSD">34800.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="RSD">174000.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="RSD">34800.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20</cbc:Percent></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="RSD">174000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="RSD">174000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="RSD">208800.00</cbc:TaxInclusiveAmount>
    <cbc:PrepaidAmount currencyID="RSD">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="RSD">208800.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">120</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="RSD">174000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Ležaj kuglični 6205 2RS</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="RSD">1450.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

describe("parseUbl (štampa SEF e-fakture)", () => {
  it("čita zaglavlje, strane, stavke, PDV i zbirove", () => {
    const p = parseUbl(UBL);
    expect(p.ok).toBe(true);
    expect(p.invoiceNumber).toBe("IF-2026-0001");
    expect(p.issueDate).toBe("2026-07-20");
    expect(p.deliveryDate).toBe("2026-07-19");
    expect(p.currency).toBe("RSD");
    expect(p.invoiceTypeCode).toBe("380");

    expect(p.supplier?.name).toBe("SERVOTEH d.o.o.");
    // PIB se normalizuje (skida se "RS"/"9948:" prefiks).
    expect(p.supplier?.taxId).toBe("101017443");
    expect(p.supplier?.city).toBe("Dobanovci");
    expect(p.customer?.name).toBe("KUPAC a.d.");

    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].name).toBe("Ležaj kuglični 6205 2RS");
    expect(p.lines[0].unit).toBe("H87");
    expect(p.lines[0].quantity.toString()).toBe("120");
    expect(p.lines[0].unitPrice.toString()).toBe("1450");
    expect(p.lines[0].vatPercent).toBe("20");

    expect(p.taxGroups).toHaveLength(1);
    expect(p.taxGroups[0].category).toBe("S");
    expect(p.taxGroups[0].taxableAmount.toString()).toBe("174000");

    expect(p.payableAmount.toString()).toBe("208800");
    expect(p.taxTotal.toString()).toBe("34800");
  });

  it("prazan XML ne baca — vraća ok=false bez greške", () => {
    const p = parseUbl(null);
    expect(p.ok).toBe(false);
    expect(p.parseError).toBeNull();
    expect(p.lines).toHaveLength(0);
    expect(p.payableAmount.toString()).toBe("0");
  });

  it("neispravan XML ne baca — vraća ok=false sa porukom", () => {
    const p = parseUbl("<Invoice><cbc:ID>X</Invoice>");
    expect(p.ok).toBe(false);
    expect(p.parseError).toBeTruthy();
  });

  it("faktura bez stavki i bez zbirova prolazi (štampa je sa napomenom)", () => {
    const p = parseUbl(
      '<?xml version="1.0"?><Invoice><cbc:ID>PRAZNA-1</cbc:ID></Invoice>',
    );
    expect(p.ok).toBe(true);
    expect(p.invoiceNumber).toBe("PRAZNA-1");
    expect(p.lines).toHaveLength(0);
    expect(p.taxGroups).toHaveLength(0);
  });
});
