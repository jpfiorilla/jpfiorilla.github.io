import { serialize } from './utils';

// CONTENT
export const siteName = 'John Fio | Composer';
export const email = 'john@audiosprite.com';

export const instagramHandle = 'audiosprite';
export const twitterHandle = 'audiosprite';
export const soundcloudHandle = 'audiosprite';
export const bandcampHandle = 'audiosprite';

export const logoFull = '';
export const logoSquare = '';
export const heroImg = '';

export const about = [
  'ORC PUNK is a small indie game studio in Brooklyn, NY.  Our goal is to make games that are beautiful, challenging, compelling, and fun.  We believe that games are an artform, as much for the creators as for the players, who create their own art in their expressions of play.  We approach every project from this frame.',
  'In addition to creating our own titles, we are also available for client work, so if you have a game idea you need brought to life, let’s talk!',
];

export const team = [
  {
    name: 'Adriano Valle',
    img: 'team_pic_adriano.jpg',
    jobTitle: 'Founder/ Creative Director',
    description: '',
    twitter: 'AdRT',
  },
  {
    name: 'Alberic Davila',
    img: 'team_pic_andy.png',
    jobTitle: 'Game Designer/ Gameplay Programmer',
    description: '',
    twitter: 'AlbericAD',
  },
];

export const games = [
  {
    img: 'game_card_img_ITD.png',
    name: 'Into The Dark',
    description:
      'INTO THE DARK is a top-down turn-based adventure/strategy game with a clean minimalist style and a dark ambient mood.',
    storeLinks: [
      {
        platform: 'android',
        link: 'googleplaylink',
      },
      {
        platform: 'ios',
        link: 'applestorelink',
      },
    ],
    releaseDate: 'Late 2018',
    heroImg: 'carousel_img_ITD.png',
    links: [
      {
        text: 'PressKit',
        link: 'http://www.etc.com',
      },
    ],
    youtubeLink: 'https://www.youtube.com/embed/fLoGNWi1pOM?rel=0',
    gameCopy:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Maecenas felis purus, vestibulum in imperdiet eu, pellentesque vel mi. Curabitur maximus ornare laoreet. Aliquam pretium velit vel laoreet aliquet. Donec a ex et mi elementum porttitor. Vestibulum id ligula purus. Aliquam hendrerit feugiat auctor.',
    gifs: [1, 2, 3, 4, 5].map(num => `HHOTR_AppVideo_1.1${num}`),
  },
];

export const pages = [
  {
    title: 'Orc Punk',
    path: '/',
  },
  ...games.map(game => ({
    title: game.name,
    path: `/games/${serialize(game.name)}`,
    component: 'Game',
    ...game,
  })),
];

// SEO

/*
  insert direct urls to the images you want to show up on social media sites when linking to this site.
  these can be uploaded to imgur, etc.
  the proper size is listed above each social media site;
  essentially, make three versions of each image and paste the imgur links.

  (that's pro mode anyway. you can just make one version and add them to any of the arrays.
  it'll work but not look optimal)
*/
export const socialMediaImages = {
  // 1200 x 1200px
  facebook: [],
  // 1200 x 660px
  twitter: [],
  // 1080 x 608px
  google: [],
};

/*
  schema stype as defined on http://schema.org/
  go to schema.org and pick the most relevant type for your site or business
  (eg, if you make videogames, search "videogames").
*/
export const schema = ''; // 'VideoGames'

export const imgDir = '/build/img/';

export const airtable = 'keyfi1tMKzvwQLlN2';
