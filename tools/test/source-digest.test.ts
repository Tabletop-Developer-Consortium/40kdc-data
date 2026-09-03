import { describe, it, expect } from "vitest";
import {
  normalizeSourceForDigest,
  sourceDigest,
} from "../src/source-digest.js";

/**
 * A representative printed rule, written the way a rules document prints it.
 * Every "same digest" case below is this rule with cosmetic noise applied;
 * every "different digest" case changes a value, an operator or a condition.
 */
const RULE =
  'Each time this model makes an attack, add 1 to the Hit roll if the target is within 6" of a friendly unit.';

/** Zero-width space — reprint noise that `\s` does not match. */
const ZWSP = "​";

describe("source-digest", () => {
  describe("digest shape", () => {
    it("is 64 lowercase hexadecimal characters", () => {
      expect(sourceDigest(RULE)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("holds no source text and no source length", () => {
      const digest = sourceDigest(RULE);
      for (const word of [
        "each",
        "model",
        "attack",
        "add",
        "hit",
        "roll",
        "target",
        "friendly",
        "unit",
      ]) {
        expect(digest).not.toContain(word);
      }
      // A one-character rule and a long one are indistinguishable by shape.
      expect(sourceDigest("1")).toHaveLength(digest.length);
      expect(sourceDigest(RULE.repeat(40))).toHaveLength(digest.length);
    });

    it("is deterministic and pinned to the published contract", () => {
      // A golden vector: any change to the normalisation contract changes this
      // value, which is the signal to add a new schema field rather than
      // silently reinterpret every stored `source_digest`.
      expect(sourceDigest("Add 1 to the Strength characteristic.")).toBe(
        "68c117c4112b6375b22a240e210a179ab92d8bfb9a115e01be5455396174ba70",
      );
      expect(sourceDigest(RULE)).toBe(sourceDigest(RULE));
    });
  });

  describe("cosmetic differences keep the digest stable", () => {
    it("ignores letter case", () => {
      expect(sourceDigest(RULE.toUpperCase())).toBe(sourceDigest(RULE));
      expect(sourceDigest(RULE.toLowerCase())).toBe(sourceDigest(RULE));
    });

    it("ignores reprint whitespace noise", () => {
      // Doubled spaces, a hard-wrapped line, a non-breaking space, leading and
      // trailing whitespace, and an invisible zero-width space.
      const reprinted = `\n  ${RULE.replace(/ /g, "  ")
        .replace("attack,", "attack,\n")
        .replace("within", "within ")
        .replace("target", `tar${ZWSP}get`)}\t\n`;
      expect(reprinted).not.toBe(RULE);
      expect(sourceDigest(reprinted)).toBe(sourceDigest(RULE));
    });

    it("ignores quote style", () => {
      expect(sourceDigest(RULE.replace('6"', "6”"))).toBe(sourceDigest(RULE));
      expect(sourceDigest(`He said “Add 1”, don’t forget: ${RULE}`)).toBe(
        sourceDigest(`He said "Add 1", don't forget: ${RULE}`),
      );
    });

    it("ignores sentence punctuation and bullet decoration", () => {
      expect(sourceDigest(RULE.replace(/[.,]/g, ""))).toBe(sourceDigest(RULE));
      expect(sourceDigest(`• ${RULE} (see FAQ)`)).toBe(
        sourceDigest(`${RULE} see FAQ`),
      );
    });

    it("folds Unicode compatibility and decomposition differences", () => {
      // Decomposed vs composed diacritic, fullwidth digit, fi ligature.
      expect(sourceDigest("Khârn adds 1")).toBe(sourceDigest("Khârn adds 1"));
      expect(sourceDigest("adds １")).toBe(sourceDigest("adds 1"));
      expect(sourceDigest("inﬂicts 1")).toBe(sourceDigest("inflicts 1"));
    });

    it("canonicalises dash and multiplication variants", () => {
      const ascii = "Re-roll the roll - then take D6 x 2 mortal wounds";
      for (const dash of ["‐", "‑", "‒", "–", "—", "―", "⁃", "−"]) {
        expect(sourceDigest(ascii.replace(/-/g, dash))).toBe(
          sourceDigest(ascii),
        );
      }
      for (const times of ["×", "✕", "✖", "⨯"]) {
        expect(sourceDigest(ascii.replace(" x ", ` ${times} `))).toBe(
          sourceDigest(ascii),
        );
      }
    });

    it("ignores spacing around a rule operator", () => {
      expect(sourceDigest("a save of 6+")).toBe(sourceDigest("a save of 6 +"));
      expect(sourceDigest("Strength -1")).toBe(sourceDigest("Strength - 1"));
      expect(sourceDigest("D6/2 damage")).toBe(sourceDigest("D6 / 2 damage"));
    });
  });

  describe("rule-significant differences change the digest", () => {
    it("detects a changed value", () => {
      expect(sourceDigest(RULE.replace("add 1", "add 2"))).not.toBe(
        sourceDigest(RULE),
      );
      expect(sourceDigest(RULE.replace('6"', '9"'))).not.toBe(
        sourceDigest(RULE),
      );
    });

    it("detects an added condition", () => {
      const withCondition = RULE.replace(
        "if the target",
        "if this model has not moved this turn and the target",
      );
      expect(withCondition).not.toBe(RULE);
      expect(sourceDigest(withCondition)).not.toBe(sourceDigest(RULE));
    });

    it("detects a removed or reworded clause", () => {
      const shortened = RULE.replace(
        ' if the target is within 6" of a friendly unit',
        "",
      );
      expect(shortened).not.toBe(RULE);
      expect(sourceDigest(shortened)).not.toBe(sourceDigest(RULE));
      expect(sourceDigest(RULE.replace("add", "subtract"))).not.toBe(
        sourceDigest(RULE),
      );
    });

    it("preserves the rule-significant operators", () => {
      expect(sourceDigest("a save of 6+")).not.toBe(
        sourceDigest("a save of 6"),
      );
      expect(sourceDigest("Strength -1")).not.toBe(sourceDigest("Strength 1"));
      expect(sourceDigest("Strength +1")).not.toBe(sourceDigest("Strength -1"));
      expect(sourceDigest("D6/2 damage")).not.toBe(sourceDigest("D6 2 damage"));
      expect(sourceDigest("50% of models")).not.toBe(
        sourceDigest("50 of models"),
      );
      expect(sourceDigest("wounds < 4")).not.toBe(sourceDigest("wounds > 4"));
      expect(sourceDigest("wounds = 4")).not.toBe(sourceDigest("wounds 4"));
    });
  });

  describe("normalizeSourceForDigest", () => {
    it("emits only letters, digits, marks, spaces and the operator allowlist", () => {
      const normalized = normalizeSourceForDigest(
        "• Re‑roll a “Hit” roll of 1 — 6+ saves (D6×2; 50%) ≤ 4!",
      );
      expect(normalized).toBe(
        "re - roll a hit roll of 1 - 6 + saves d6x2 50 % 4",
      );
      expect(normalized).toMatch(/^[\p{L}\p{N}\p{M} +\-=<>\/%]*$/u);
    });

    it("collapses whitespace and trims", () => {
      expect(normalizeSourceForDigest("  add \t\n 1  ")).toBe("add 1");
      expect(normalizeSourceForDigest("add　1")).toBe("add 1");
      expect(normalizeSourceForDigest(`add${ZWSP} 1`)).toBe("add 1");
    });

    it("is idempotent", () => {
      for (const input of [
        RULE,
        "• Re‑roll a “Hit” roll of 1 — 6+ saves",
        "Khİrn ≤ D6×2 (50%)",
        "",
        "   ",
      ]) {
        const once = normalizeSourceForDigest(input);
        expect(normalizeSourceForDigest(once)).toBe(once);
      }
    });

    it("returns an empty string for input with no rule content", () => {
      expect(normalizeSourceForDigest("")).toBe("");
      expect(normalizeSourceForDigest(`  ${ZWSP}\t\n `)).toBe("");
      expect(normalizeSourceForDigest("• “”,.")).toBe("");
      // Dashes survive as operators, so decoration made of them is not empty.
      expect(normalizeSourceForDigest("• ——")).toBe("- -");
    });
  });

  describe("empty source", () => {
    it("refuses to digest a rule that normalises to nothing", () => {
      for (const empty of ["", "   ", ` ${ZWSP}`, "“”,.;()"]) {
        expect(() => sourceDigest(empty)).toThrow(RangeError);
      }
    });

    it("reports the refusal without echoing the input", () => {
      const secret = "“”,.;()";
      let message = "";
      try {
        sourceDigest(secret);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(
        "source rule is empty after normalisation; refusing to digest it",
      );
      expect(message).not.toContain(secret);
    });
  });
});
