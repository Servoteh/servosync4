import { BadRequestException } from "@nestjs/common";

/**
 * Telo za POST /zahtevi/:id/return-for-info (admin) — ATOMSKO vraćanje na dopunu:
 * N pitanja (komentari isQuestion=true) + prelaz u NEEDS_INFO + opciona napomena +
 * mejl podnosiocu, sve u JEDNOJ transakciji. Zamena za raniji krhki dvokorak
 * (addComment pa decision) koji je mogao ostaviti pitanje bez prelaza (23.07 review).
 */
export interface ReturnForInfoDto {
  /** Pitanja podnosiocu — svako postaje komentar isQuestion=true. Bar jedno neprazno. */
  questions: string[];
  /** Opciona napomena (razlog/kontekst) — upisuje se u decisionNote (ili null). */
  note?: string;
}

const MAX_QUESTIONS = 20;
const MAX_QUESTION_LEN = 4000;

export function validateReturnForInfo(dto: ReturnForInfoDto): void {
  const errors: string[] = [];
  if (!Array.isArray(dto.questions))
    errors.push("Polje `questions` mora biti niz tekstova.");
  else {
    const cleaned = dto.questions
      .filter((q) => typeof q === "string")
      .map((q) => q.trim())
      .filter(Boolean);
    if (cleaned.length === 0)
      errors.push("Navedite bar jedno pitanje podnosiocu.");
    if (dto.questions.length > MAX_QUESTIONS)
      errors.push(`Najviše ${MAX_QUESTIONS} pitanja odjednom.`);
    if (dto.questions.some((q) => typeof q === "string" && q.length > MAX_QUESTION_LEN))
      errors.push(`Pitanje je predugačko (najviše ${MAX_QUESTION_LEN} znakova).`);
  }
  if (dto.note !== undefined && typeof dto.note !== "string")
    errors.push("Napomena mora biti tekst.");
  if (errors.length) throw new BadRequestException(errors);
}
