/**
 * Test: Nudge regex patterns
 * Verifies the regex correctly identifies tool-suggesting phrases
 * while excluding conversational phrases
 */

// The actual regex from route.ts (keep in sync)
const NUDGE_REGEX = /\b(let me(?! know)|i'll (?!be\b)|i will (?!be\b)|i can (?!help|assist)|i'?m going to|i'?ve (?!been\b)|here(?:'s| is) (?:a |your |the )|checking|looking|searching|analyzing|reviewing|creating|sending|generating|taking|fetching|getting|moving|uploading|downloading|drawing|making|composing|preparing|producing|capturing|snapping|crafting|writing|saving|setting up|working on)\b/;

describe('Nudge Regex', () => {
  describe('Should MATCH (tool-suggesting phrases)', () => {
    const shouldMatch = [
      'Let me generate an image for you',
      "I'll create a selfie now",
      'I will search for that information',
      "I'm going to take a picture",
      'Creating your image now...',
      'Generating a selfie as requested',
      'Taking a picture for you',
      'Searching for the latest news',
      'Checking the weather for you',
      'Looking up that information',
      'Analyzing the image you sent',
      'Reviewing your project files',
      'Sending the notification now',
      'Fetching the weather data',
      'Getting the forecast for today',
      'Downloading the file for you',
      'Uploading your document',
      'Drawing a picture of a cat',
      'Making a selfie for you',
      'Composing your morning briefing',
      'Preparing the report now',
      'Producing an image based on your description',
      'Capturing a selfie right now',
      'Snapping a photo for you',
      'Crafting an image of a sunset',
      'Writing the file to your project',
      'Saving the image to your workspace',
      'Setting up the project folder',
      'Working on your request',
      "Here's a selfie for you",
      "Here is your image",
      "Here's the weather forecast",
      "I've generated your image",
      "I've created a selfie",
      "I can generate that for you",
    ];

    test.each(shouldMatch)('matches: "%s"', (phrase) => {
      expect(NUDGE_REGEX.test(phrase.toLowerCase())).toBe(true);
    });
  });

  describe('Should NOT match (conversational phrases)', () => {
    const shouldNotMatch = [
      'Let me know if you need anything else',
      "I'll be here if you need me",
      'I will be happy to help later',
      'I can help you with that',
      'I can assist you with that',
      "I've been thinking about that",
      'Sure, sounds good!',
      'That looks great',
      'Thank you for asking',
      'You are welcome',
      'Have a great day',
      'Good morning, friend!',
      'The weather is nice today',
      'Your project is coming along well',
    ];

    test.each(shouldNotMatch)('does NOT match: "%s"', (phrase) => {
      expect(NUDGE_REGEX.test(phrase.toLowerCase())).toBe(false);
    });
  });

  describe('Regex is in sync with route.ts', () => {
    test('route.ts contains the expected regex pattern', () => {
      const { readFileSync } = require('fs');
      const path = require('path');
      const routeContent = readFileSync(
        path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'),
        'utf-8'
      );
      // Check key parts of the regex are present
      expect(routeContent).toContain('let me(?! know)');
      expect(routeContent).toContain("i'll (?!be\\b)");
      expect(routeContent).toContain('drawing|making|composing');
      expect(routeContent).toContain('capturing|snapping|crafting');
      expect(routeContent).toContain('setting up|working on');
      expect(routeContent).toContain("i'?ve (?!been\\b)");
      expect(routeContent).toContain("here(?:'s| is) (?:a |your |the )");
    });
  });
});
