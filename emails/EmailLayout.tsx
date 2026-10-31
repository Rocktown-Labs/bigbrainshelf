import React from "react";
import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// Shared shell for every Big Brain Shelf email: navy header band with the
// wordmark (BRAIN in the brand orange, same rule as the book covers),
// a white card for the message, and a quiet footer. All styling is inline,
// as email clients require.

export const BRAND = {
  navy: "#1a3454",
  orange: "#fb923c",
  paper: "#faf9f7",
  ink: "#1c1917",
  muted: "#57534e",
  line: "#e7e5e4",
};

export const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function EmailLayout({
  preview,
  children,
}: {
  preview: string;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: BRAND.paper,
          fontFamily,
          margin: 0,
          padding: "24px 0",
        }}
      >
        <Container
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            border: `1px solid ${BRAND.line}`,
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <Section
            style={{
              backgroundColor: BRAND.navy,
              padding: "20px 32px",
              borderBottom: `4px solid ${BRAND.orange}`,
            }}
          >
            <Text
              style={{
                color: "#ffffff",
                fontSize: "20px",
                fontWeight: 700,
                letterSpacing: "1.5px",
                margin: 0,
              }}
            >
              BIG <span style={{ color: BRAND.orange }}>BRAIN</span> SHELF
            </Text>
          </Section>
          <Section style={{ padding: "28px 32px 8px" }}>{children}</Section>
          <Section
            style={{
              padding: "16px 32px 24px",
              borderTop: `1px solid ${BRAND.line}`,
            }}
          >
            <Text
              style={{
                color: BRAND.muted,
                fontSize: "12px",
                lineHeight: "18px",
                margin: 0,
              }}
            >
              Big Brain Shelf · bigbrainshelf.com · Story and coloring books
              that sneak big ideas to little readers.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export const styles = {
  heading: {
    color: BRAND.navy,
    fontSize: "22px",
    lineHeight: "30px",
    fontWeight: 700,
    margin: "0 0 16px",
  } as React.CSSProperties,
  sectionHeading: {
    color: BRAND.navy,
    fontSize: "16px",
    lineHeight: "24px",
    fontWeight: 700,
    margin: "24px 0 8px",
  } as React.CSSProperties,
  paragraph: {
    color: BRAND.ink,
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 12px",
  } as React.CSSProperties,
  listItem: {
    color: BRAND.ink,
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 4px",
  } as React.CSSProperties,
  muted: {
    color: BRAND.muted,
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 12px",
  } as React.CSSProperties,
};
