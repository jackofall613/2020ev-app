// Public support page — the Support URL required by App Store Connect.
export const metadata = { title: 'Support — 2020EV' };

export default function SupportPage() {
  return (
    // The portal's global background is dark (#0A0F1E); these public pages need
    // their own light canvas to stay readable.
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-2xl px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-2">Support</h1>
      <p className="text-sm text-gray-500 mb-8">
        Help with the 2020EV app for shared EV charging.
      </p>

      <section className="space-y-6 leading-relaxed">
        <h2 className="text-xl font-semibold">How do I get access?</h2>
        <p>
          2020EV is invite-only. If your building shares an EV charger through
          2020EV, ask your building&apos;s administrator for an invitation link —
          accounts cannot be created without one. If your building doesn&apos;t use
          2020EV yet and you&apos;d like it to, email us below.
        </p>

        <h2 className="text-xl font-semibold">Login and password</h2>
        <p>
          You sign in with the email address your invitation was sent to. You can
          change your password from the app; if you&apos;re locked out, your
          building&apos;s administrator can send you a fresh invitation.
        </p>

        <h2 className="text-xl font-semibold">Wallet balance and charges</h2>
        <p>
          Your wallet tracks your share of the building&apos;s electricity costs.
          Top-ups are handled by your building&apos;s administrator — the app itself
          takes no payments. If a charging session looks wrong, contact your
          administrator, who can review and correct it.
        </p>

        <h2 className="text-xl font-semibold">Deleting your account</h2>
        <p>
          Open the Profile screen in the app and choose delete account. Your name,
          email, photo, and login credentials are permanently removed; see the{' '}
          <a href="/privacy" className="text-blue-600 underline">
            Privacy Policy
          </a>{' '}
          for details.
        </p>

        <h2 className="text-xl font-semibold">Contact us</h2>
        <p>
          For anything else — bugs, questions, or bringing 2020EV to your building —
          email{' '}
          <a href="mailto:support@2020ev.app" className="text-blue-600 underline">
            support@2020ev.app
          </a>
          . We aim to reply within two business days.
        </p>
      </section>
      </div>
    </main>
  );
}
