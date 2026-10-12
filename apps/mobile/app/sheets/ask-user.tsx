import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { DisclosureGroup, Section, Text, TextField, VStack, useNativeState } from '@expo/ui/swift-ui';
import { disabled, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useAskForms } from '../../src/chat/ask-user-store';
import { canSubmitAnswers, formatAnswers, keyOf, type Answers, type Question } from '../../src/chat/ask-user-model';
import { useT } from '../../src/lib/i18n';
import { EmptyState } from '../../src/ui/empty';
import { FormCheckRow, NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { brandFont } from '../../src/ui/brand-font';

export default function AskUserSheet() {
  const { k = '' } = useLocalSearchParams<{ k?: string }>();
  const form = useAskForms((s) => s.forms[k]);
  const router = useRouter();
  const navigation = useNavigation();
  const t = useT();
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const readers = useRef(new Map<string, () => string>());
  useEffect(() => navigation.addListener('beforeRemove', Keyboard.dismiss), [navigation]);
  useEffect(() => {
    if (form?.status === 'sent') {
      Keyboard.dismiss();
      router.back();
    }
  }, [form?.status, router]);
  if (!form)
    return (
      <>
        <SheetClose />
        <EmptyState icon="form" title={t('chat.expired')} message={t('chat.expiredHint')} style={{ flex: 1 }} />
      </>
    );
  const { data, answers, status, readOnly } = form;
  const saving = status === 'queued' || status === 'sending';
  const set = (key: string, value: string | string[]) => {
    const current = useAskForms.getState().forms[k];
    if (current && !saving)
      useAskForms.getState().patch(k, { answers: { ...current.answers, [key]: value }, status: 'editing' });
  };
  const question = (q: Question, i: number) => {
    const key = keyOf(q, i);
    const control = (
      <>
        {q.type === 'single_choice' ? (
          (q.options ?? []).map((o) => (
            <FormCheckRow
              key={o.value}
              label={o.label}
              checked={answers[key] === o.value}
              choice="single"
              onPress={() => set(key, o.value)}
            />
          ))
        ) : q.type === 'multi_choice' ? (
          (q.options ?? []).map((o) => {
            const values = Array.isArray(answers[key]) ? (answers[key] as string[]) : [];
            return (
              <FormCheckRow
                key={o.value}
                label={o.label}
                checked={values.includes(o.value)}
                choice="multiple"
                onPress={() =>
                  set(key, values.includes(o.value) ? values.filter((v) => v !== o.value) : [...values, o.value])
                }
              />
            );
          })
        ) : (
          <AnswerField
            question={q}
            initial={typeof answers[key] === 'string' ? (answers[key] as string) : ''}
            locked={readOnly || saving}
            onChange={(value) => set(key, value)}
            register={(read) => {
              if (read) readers.current.set(key, read);
              else readers.current.delete(key);
            }}
          />
        )}
      </>
    );
    return q.required === false ? (
      <VStack key={key} alignment="leading" modifiers={[disabled(readOnly || saving)]}>
        <Text>{q.label}</Text>
        {control}
      </VStack>
    ) : (
      <Section key={key} title={q.label} modifiers={[disabled(readOnly || saving)]}>
        {control}
      </Section>
    );
  };
  return (
    <>
      <FormChrome
        title={data.title || t('chat.askTitle')}
        dirty={Object.values(answers).some((v) => v.length > 0)}
        canSave={!readOnly && canSubmitAnswers(data.questions, answers)}
        saving={saving}
        saveLabel={t('chat.askSubmit')}
        onSave={() => {
          const current = useAskForms.getState().forms[k];
          if (!current || current.readOnly || ['queued', 'sending', 'sent'].includes(current.status)) return;
          const values: Answers = { ...current.answers };
          for (const [key, read] of readers.current) values[key] = read();
          if (!canSubmitAnswers(data.questions, values)) return;
          Keyboard.dismiss();
          useAskForms
            .getState()
            .patch(k, { answers: values, message: formatAnswers(data.questions, values), status: 'queued' });
        }}
      />
      <NativeForm>
        {data.questions.map((q, i) => (q.required !== false ? question(q, i) : null))}
        {data.questions.some((q) => q.required === false) ? (
          <Section>
            <DisclosureGroup
              label={t('chat.askOptionalFields')}
              isExpanded={optionalOpen}
              onIsExpandedChange={setOptionalOpen}
            >
              {data.questions.map((q, i) => (q.required === false ? question(q, i) : null))}
            </DisclosureGroup>
          </Section>
        ) : null}
        {data.description ? (
          <Section>
            <DisclosureGroup label={t('chat.askDetails')} isExpanded={detailsOpen} onIsExpandedChange={setDetailsOpen}>
              <Text modifiers={[brandFont({ textStyle: 'footnote' })]}>{data.description}</Text>
            </DisclosureGroup>
          </Section>
        ) : null}
        {status === 'failed' ? <Section footer={<Text>{t('chat.askFailed')}</Text>}>{null}</Section> : null}
      </NativeForm>
    </>
  );
}
function AnswerField({
  question,
  initial,
  locked,
  onChange,
  register,
}: {
  question: Question;
  initial: string;
  locked: boolean;
  onChange(value: string): void;
  register(read: (() => string) | null): void;
}) {
  const value = useNativeState(initial);
  useEffect(() => {
    register(() => value.get());
    return () => register(null);
  }, [register, value]);
  return (
    <TextField
      text={value}
      placeholder={question.placeholder || question.label}
      onTextChange={onChange}
      axis={question.type === 'textarea' ? 'vertical' : 'horizontal'}
      modifiers={[disabled(locked), lineLimit(question.type === 'textarea' ? 4 : 1)]}
    />
  );
}
