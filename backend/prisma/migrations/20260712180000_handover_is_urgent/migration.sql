-- HITNO flag na primopredaji (Miljan t.10): approver označava hitne crteže pri
-- slanju tehnolozima (legacy: crvene nalepnice HITNO na odštampanom TP-u).
-- APP-ONLY kolona na ServoSync-owned tabeli (isti presedan kao technologist_id).
ALTER TABLE "drawing_handovers"
  ADD COLUMN "is_urgent" BOOLEAN NOT NULL DEFAULT false;
