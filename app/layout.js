import './globals.css';

export const metadata = {
  title: 'Docs Manager',
  description: 'AI-Powered Document Classifier & Vault',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#004838',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/150px-WhatsApp.svg.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
