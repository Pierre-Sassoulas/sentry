import {useCallback, useMemo} from 'react';
import styled from '@emotion/styled';

import CompactSelect from 'sentry/components/compactSelect';
import {IconList} from 'sentry/icons';
import {t, tn} from 'sentry/locale';
import space from 'sentry/styles/space';
import {SelectValue} from 'sentry/types';
import {defined} from 'sentry/utils';
import {FlamegraphState} from 'sentry/utils/profiling/flamegraph/flamegraphStateProvider/flamegraphContext';
import {ProfileGroup} from 'sentry/utils/profiling/profile/importProfile';
import {Profile} from 'sentry/utils/profiling/profile/profile';
import {makeFormatter} from 'sentry/utils/profiling/units/units';

interface FlamegraphThreadSelectorProps {
  onThreadIdChange: (threadId: Profile['threadId']) => void;
  profileGroup: ProfileGroup;
  threadId: FlamegraphState['profiles']['threadId'];
}

function FlamegraphThreadSelector({
  threadId,
  onThreadIdChange,
  profileGroup,
}: FlamegraphThreadSelectorProps) {
  const [profileOptions, emptyProfileOptions]: [
    SelectValue<number>[],
    SelectValue<number>[]
  ] = useMemo(() => {
    const profiles: SelectValue<number>[] = [];
    const emptyProfiles: SelectValue<number>[] = [];
    const activeThreadId =
      typeof profileGroup.activeProfileIndex === 'number'
        ? profileGroup.profiles[profileGroup.activeProfileIndex]?.threadId
        : undefined;
    const sortedProfiles = [...profileGroup.profiles].sort(
      compareProfiles(activeThreadId)
    );

    sortedProfiles.forEach(profile => {
      const option = {
        label: profile.name ? profile.name : `tid(${profile.threadId})`,
        value: profile.threadId,
        details: (
          <ThreadLabelDetails
            duration={makeFormatter(profile.unit)(profile.duration)}
            // plus 1 because the last sample always has a weight of 0
            // and is not included in the raw weights
            samples={profile.rawWeights.length + 1}
          />
        ),
      };

      if (profile.rawWeights.length > 0) {
        profiles.push(option);
        return;
      }
      emptyProfiles.push(option);
      return;
    });
    return [profiles, emptyProfiles];
  }, [profileGroup]);

  const handleChange: (opt: SelectValue<number>) => void = useCallback(
    opt => {
      if (defined(opt)) {
        onThreadIdChange(opt.value);
      }
    },
    [onThreadIdChange]
  );

  return (
    <CompactSelect
      triggerProps={{
        icon: <IconList size="xs" />,
        size: 'xs',
      }}
      options={[
        {
          // TODO: fix CompactSelect types to better represent usage.
          // this value has no effect on the selection, it's simply to satisfy the types..
          // tried modifying the types but it creates a lot of errors
          value: threadId || 0,
          label: t('Profiles'),
          options: profileOptions,
        },
        {
          value: threadId || 0,
          label: t('Empty Profiles'),
          options: emptyProfileOptions,
        },
      ]}
      value={threadId}
      onChange={handleChange}
      isSearchable
    />
  );
}

interface ThreadLabelDetailsProps {
  duration: string;
  samples: number;
}

function ThreadLabelDetails(props: ThreadLabelDetailsProps) {
  return (
    <DetailsContainer>
      <div>{props.duration}</div>
      <div>{tn('%s sample', '%s samples', props.samples)}</div>
    </DetailsContainer>
  );
}

type ProfileLight = {
  name: Profile['name'];
  threadId: Profile['threadId'];
};

export function compareProfiles(activeThreadId?: number) {
  return function (a: ProfileLight, b: ProfileLight): number {
    // if one is the active thread id, it should be first
    if (defined(activeThreadId)) {
      if (a.threadId === activeThreadId) {
        return -1;
      }
      if (b.threadId === activeThreadId) {
        return 1;
      }
    }

    // if neither has a name, we use the thread id
    if (!b.name && !a.name) {
      return a.threadId > b.threadId ? 1 : -1;
    }

    // if one doesn't have a name, the other is first
    if (!b.name) {
      return -1;
    }
    if (!a.name) {
      return 1;
    }

    // if both has a name, we use the name
    return a.name > b.name ? 1 : -1;
  };
}

const DetailsContainer = styled('div')`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  gap: ${space(1)};
`;

export {FlamegraphThreadSelector};
