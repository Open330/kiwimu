import { expect, test, describe } from "bun:test";
import { slugify, cleanTitle } from "./chunker";

describe("slugify", () => {
  test("영어 텍스트", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });
  test("한국어 텍스트", () => {
    expect(slugify("양자역학")).toBe("양자역학");
  });
  test("한영 혼합", () => {
    expect(slugify("Chapter 3 양자역학")).toBe("chapter-3-양자역학");
  });
  test("특수문자 제거", () => {
    expect(slugify("Hello! @World#")).toBe("hello-world");
  });
  test("빈 문자열", () => {
    expect(slugify("")).toBe("");
  });
  test("연속 공백/하이픈", () => {
    expect(slugify("hello   world---test")).toBe("hello-world-test");
  });
  test("80자 제한", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
  test("한글 자모", () => {
    expect(slugify("ㅋㅋㅋ 테스트")).toBe("ㅋㅋㅋ-테스트");
  });
  test("Unicode 문자와 결합 문자를 보존", () => {
    expect(slugify("Crème brûlée 東京 Δοκιμή")).toBe("crème-brûlée-東京-δοκιμή");
  });
  test("Unicode 이모지는 제거", () => {
    expect(slugify("학습 🥝 wiki")).toBe("학습-wiki");
  });
});

describe("cleanTitle", () => {
  test("Chapter 번호 제거", () => {
    expect(cleanTitle("Chapter 3 Quantum Mechanics")).toBe("Quantum Mechanics");
  });
  test("숫자 접두사 제거", () => {
    expect(cleanTitle("3.2.1 Angular Momentum")).toBe("Angular Momentum");
  });
  test("일반 제목 유지", () => {
    expect(cleanTitle("Quantum Mechanics")).toBe("Quantum Mechanics");
  });
});
