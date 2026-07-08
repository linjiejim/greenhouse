/**
 * ProjectFormSheet — create / edit a project (web parity: the projects page
 * create dialog + project-detail's edit form): title, description, status
 * (edit), priority, owner, dates, color swatches, visibility.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { AssignableUser, Project, ProjectInput } from '../api/projects';
import { createProject, updateProject } from '../api/projects';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { BottomSheetScrollView, Button, DateField, Field, Icon, Segmented, Sheet, Touchable } from '../ui';
import { font, makeStyles, useTheme } from '../theme';
import { FormLabel, OptionChips, PickerRow } from './form-bits';
import { UserPickerSheet } from './user-picker-sheet';
import {
  PRIORITIES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  priorityColor,
  priorityLabel,
  projectStatusColor,
  projectStatusLabel,
} from './meta';

export function ProjectFormSheet({
  visible,
  onClose,
  project,
  users,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  /** Present → edit mode. */
  project?: Project | null;
  users: AssignableUser[];
  onSaved: (projectId: number) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const me = useAuth((s) => s.user);

  const isEdit = !!project;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Project['status']>('planning');
  const [priority, setPriority] = useState<Project['priority']>('normal');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Project['visibility']>('public');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setError('');
    setTitle(project?.title ?? '');
    setDescription(project?.description ?? '');
    setStatus(project?.status ?? 'planning');
    setPriority(project?.priority ?? 'normal');
    setOwnerId(project?.owner_id ?? me?.id ?? null);
    setStartDate(project?.start_date?.slice(0, 10) ?? null);
    setEndDate(project?.end_date?.slice(0, 10) ?? null);
    setColor(project?.color ?? null);
    setVisibility(project?.visibility ?? 'public');
  }, [visible, project, me]);

  const ownerName = useMemo(
    () => (ownerId ? users.find((u) => u.id === ownerId)?.nickname ?? ownerId : null),
    [ownerId, users],
  );

  const save = async () => {
    if (!title.trim()) {
      setError(t('projects.titleRequired'));
      return;
    }
    setSaving(true);
    setError('');
    const body: ProjectInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      owner_id: ownerId ?? undefined,
      start_date: startDate,
      end_date: endDate,
      color,
      visibility,
    };
    let savedId: number | null;
    if (isEdit) {
      body.status = status;
      const updated = await updateProject(project!.id, body);
      savedId = updated?.id ?? null;
    } else {
      const created = await createProject({ ...body, title: title.trim() });
      savedId = created?.id ?? null;
    }
    setSaving(false);
    if (savedId === null) {
      setError(t('projects.saveFailed'));
      return;
    }
    onSaved(savedId);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={isEdit ? t('projects.editProject') : t('projects.newProject')} heightPct={88}>
      <BottomSheetScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field placeholder={t('projects.namePlaceholder')} value={title} onChangeText={setTitle} />
        <Field
          placeholder={t('projects.descPlaceholder')}
          value={description}
          onChangeText={setDescription}
          multiline
          style={{ minHeight: 64, paddingTop: 4 }}
        />

        {isEdit ? (
          <View>
            <FormLabel text={t('projects.status')} />
            <OptionChips
              options={PROJECT_STATUSES.map((s) => ({ id: s, label: projectStatusLabel(s, t), color: projectStatusColor(s, c) }))}
              value={status}
              onChange={setStatus}
            />
          </View>
        ) : null}

        <View>
          <FormLabel text={t('projects.priority')} />
          <OptionChips
            options={PRIORITIES.map((p) => ({ id: p, label: priorityLabel(p, t), color: priorityColor(p, c) }))}
            value={priority}
            onChange={setPriority}
          />
        </View>

        <View>
          <FormLabel text={t('projects.owner')} />
          <PickerRow value={ownerName} placeholder={t('projects.unassigned')} onPress={() => setPickerOpen(true)} />
        </View>

        <View style={styles.dateRow}>
          <View style={{ flex: 1 }}>
            <DateField label={t('projects.startDate')} value={startDate} onChange={setStartDate} />
          </View>
          <View style={{ flex: 1 }}>
            <DateField label={t('projects.endDate')} value={endDate} onChange={setEndDate} />
          </View>
        </View>

        <View>
          <FormLabel text={t('projects.color')} />
          <View style={styles.swatchRow}>
            {PROJECT_COLORS.map((hex) => {
              const active = color === hex;
              return (
                <Touchable
                  key={hex}
                  haptic="selection"
                  accessibilityLabel={hex}
                  onPress={() => setColor(active ? null : hex)}
                  style={[styles.swatch, { backgroundColor: hex }, active && styles.swatchActive]}
                >
                  {active ? <Icon name="check" size={14} color="#fff" sw={3} /> : null}
                </Touchable>
              );
            })}
          </View>
        </View>

        <View>
          <FormLabel text={t('projects.visibility')} />
          <Segmented<Project['visibility']>
            items={[
              { id: 'public', label: t('projects.visibility_public') },
              { id: 'private', label: t('projects.visibility_private') },
            ]}
            value={visibility}
            onChange={setVisibility}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button label={isEdit ? t('common.save') : t('common.create')} loading={saving} onPress={save} />
      </BottomSheetScrollView>

      <UserPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        users={users}
        selectedId={ownerId}
        onPick={(id) => setOwnerId(id ?? me?.id ?? null)}
      />
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40, gap: 14 },
  dateRow: { flexDirection: 'row', gap: 10 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  swatchActive: { borderWidth: 2, borderColor: c.fg },
  error: { fontSize: font.small, color: c.danger },
}));
