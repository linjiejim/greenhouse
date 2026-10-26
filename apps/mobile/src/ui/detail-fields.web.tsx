import React from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';
import { Section, Row } from './list';
import { DetailFieldsContext } from './detail-context.web';
import { FieldValue } from './field-value.web';
import { useTheme } from '../theme';
export function DetailFields(props: React.ComponentProps<typeof Section>) {
  const { width } = useWindowDimensions();
  if (width < 760) return <Section {...props} />;
  return (
    <DetailFieldsContext.Provider value={true}>
      <section className="gh-object-fields" aria-label={props.header}>
        {props.children}
      </section>
    </DetailFieldsContext.Provider>
  );
}
export function DetailScroll(props: React.ComponentProps<typeof ScrollView>) {
  const { width } = useWindowDimensions();
  const { colors: c } = useTheme();
  return (
    <ScrollView
      {...props}
      testID={width >= 760 ? 'object-detail' : props.testID}
      style={[props.style, width >= 760 && { backgroundColor: c.background }]}
    />
  );
}
export function DetailField({
  label,
  value,
  kind,
  last,
}: {
  label: string;
  value: string;
  kind: string;
  last?: boolean;
}) {
  const { width } = useWindowDimensions();
  if (width < 760) return <Row last={last} title={label} subtitle={value || '—'} subtitleLines={8} accessory="none" />;
  return (
    <div className="gh-object-field">
      <span className="gh-object-label">{label}</span>
      <span className="gh-object-value">
        <FieldValue kind={kind} text={value} />
      </span>
    </div>
  );
}
