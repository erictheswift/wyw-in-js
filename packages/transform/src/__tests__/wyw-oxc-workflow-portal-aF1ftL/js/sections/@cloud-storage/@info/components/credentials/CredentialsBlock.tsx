import { styled } from '@linaria/react';

import CredentialValue from "_/components/Details/CredentialValue";

const CredentialsBlock = styled.div`
  & > div {
    display: flex;
    align-items: center;

    & > div:last-of-type {
      padding-left: 20px;
    }
  }
`;

export const CredentialText = styled(CredentialValue)`
  max-width: initial;
  background-color: var(--readonly-bg);
`;

export default CredentialsBlock;