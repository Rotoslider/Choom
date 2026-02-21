import type { TimeContext } from './types';

export function getTimeContext(timezone: string = 'America/New_York'): TimeContext {
  const now = new Date();

  // Get localized date/time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value || '';

  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now)
  );

  // Determine time of day
  let timeOfDay: TimeContext['timeOfDay'];
  if (hour >= 5 && hour < 12) {
    timeOfDay = 'morning';
  } else if (hour >= 12 && hour < 17) {
    timeOfDay = 'afternoon';
  } else if (hour >= 17 && hour < 21) {
    timeOfDay = 'evening';
  } else {
    timeOfDay = 'night';
  }

  // Determine season (Northern Hemisphere)
  const month = now.getMonth();
  let season: TimeContext['season'];
  if (month >= 2 && month <= 4) {
    season = 'spring';
  } else if (month >= 5 && month <= 7) {
    season = 'summer';
  } else if (month >= 8 && month <= 10) {
    season = 'fall';
  } else {
    season = 'winter';
  }

  const dayOfWeek = getPart('weekday');
  const formattedDateTime = formatter.format(now);

  return {
    currentTime: now.toLocaleTimeString('en-US', { timeZone: timezone }),
    currentDate: now.toLocaleDateString('en-US', { timeZone: timezone }),
    dayOfWeek,
    timeOfDay,
    season,
    timezone,
    formattedDateTime,
  };
}

export function formatTimeContextForPrompt(context: TimeContext): string {
  return `Current date and time: ${context.formattedDateTime}
Day: ${context.dayOfWeek}
Time of day: ${context.timeOfDay}
Season: ${context.season}
Timezone: ${context.timezone}`;
}

export function getGreeting(timeOfDay: TimeContext['timeOfDay']): string {
  switch (timeOfDay) {
    case 'morning':
      return 'Good morning';
    case 'afternoon':
      return 'Good afternoon';
    case 'evening':
      return 'Good evening';
    case 'night':
      return 'Hello';
  }
}
